/**
 * GET /api/cron/ladder-watch — the autonomous Armed-Ladder watcher tick.
 *
 * An external scheduler (cron-job.org / GHA, like the other crons) hits this with the
 * dedicated ladder cron bearer (set CRON_SECRET = the same value so Vercel's
 * auto-injected `Authorization: Bearer $CRON_SECRET` also matches). It evaluates ARMED
 * ladders against the latest COMPLETED candle and fires met PENDING rungs via
 * performLadderRungFire — which re-validates the full guard stack + the
 * LADDER_AUTOFIRE_ENABLED kill-switch. A no-op (and near-zero cost) when autofire is off.
 *
 * Runs server-side on Vercel (where the key already lives), so it calls the fire path
 * directly; the fire route remains the single enforcement point either way.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronBearer } from '@/lib/infrastructure/auth/auth';
import { getLadderCronSecret, isReversionAlertEnabled, isTrendAlertEnabled, isRunawayAlertEnabled } from '@/lib/ladder/ladder-flags';
import { runRunawayAlertCycle } from '@/lib/ladder/runaway-alert-service';
import { runReversionAlertCycle } from '@/lib/ladder/reversion-alert-service';
import { runEventPrepAlert } from '@/lib/ladder/event-prep-alert-service';
import { runTrendAlertCycle } from '@/lib/ladder/trend-alert-service';
import { runTrendFlipGuard } from '@/lib/ladder/trend-flip-guard-service';
import { runLadderWatchTick } from '@/lib/ladder/ladder-watch-service';
import { runLeaderGuard } from '@/lib/ladder/ladder-leader-guard-service';
import { runExpiryAlerts } from '@/lib/ladder/ladder-expiry-alert-service';
import { checkPriceAlerts } from '@/lib/ladder/price-alert-service';
import { checkScoutHeartbeats } from '@/lib/scout/scout-heartbeat-alert-service';
import { resolveStewardProposals } from '@/lib/scout/steward-proposal-resolver-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import { validateEnv } from '@/lib/env/env';
import { pingHealthcheck } from '@/lib/infrastructure/monitoring/healthcheck';

export const dynamic = 'force-dynamic';
// Pinned EXPLICITLY (review 08-13): the tick runs serial fail-soft lanes whose HL reads
// now retry on 429 (worst case ~17s per uncached fire-path call, more for default
// readers) — the budget must be a stated invariant, not the platform default du jour.
// A platform kill mid-fire is the nightmare (post-claim = burned one-shot claim;
// post-fill pre-bracket = filled-but-unstopped), so keep this generous.
export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronBearer(request, getLadderCronSecret())) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  // External dead-man's-switch (healthchecks.io): ping only AFTER auth, so a bad caller
  // can't keep a dead watcher's check green. /start brackets the run; success/fail close it.
  const hcUrl = validateEnv().LADDER_WATCH_HEALTHCHECK_URL;
  await pingHealthcheck(hcUrl, 'start');
  try {
    //  - trend flip guard FIRST (DISARM-ONLY, fail-soft): if the 8h stance already
    //    left bullish, pending trend rungs must be disarmed BEFORE this tick's fire
    //    pass loads the armed list — otherwise a rung can fire on the very tick the
    //    thesis died. Runs whenever the stance bridge is configured (even with
    //    drafting off); never fires or closes anything.
    const trendFlipGuard = await runTrendFlipGuard(Date.now()).catch((e) => ({ checked: -1, disarmed: [], stanceUnreadable: false, error: extractErrorMessage(e) }));
    const summary = await runLadderWatchTick({ now: Date.now() });
    // Fire pass is DONE — close the dead-man's-switch NOW, before the advisory lanes below.
    // They do candle I/O (the reversion scan fetches up to 8 coins); letting them run first
    // would defer the 'success' ping and could trip the external check on a perfectly healthy
    // fire tick. Wrapped: a healthcheck-endpoint blip must never flip a good tick to 'fail'.
    await pingHealthcheck(hcUrl, 'success').catch(() => {});
    // SIDE-LANE THROTTLE (08-18, Vercel Active-CPU budget): the FIRE pass above runs
    // every external-cron tick (~2min) — its latency is sacred. The advisory side lanes
    // below don't need that cadence; they run only on ticks landing in the first 2
    // minutes of each 10-minute wall-clock window (stateless — serverless has no
    // counter), ≈1 in 5 ticks. Latency impact: leader/flip disarms ≤10min (risk-
    // REDUCING, on $-capped ladders), event-prep still gets ≥2 checks inside its 30-min
    // lead, heartbeat thresholds are 30/90min. The trend FLIP guard above is NOT
    // throttled (it must precede every fire pass).
    const fullTick = new Date().getUTCMinutes() % 10 < 2;
    const throttled = { skipped: 'throttled' } as const;
    //  - leader guard: DISARM-ONLY — kills copy-thesis ladders whose leader exited/flipped.
    //  - expiry alert: ADVISORY — one page when an armed ladder nears expiry unfired.
    const leaderGuard = fullTick
      ? await runLeaderGuard(Date.now()).catch((e) => ({ checked: -1, disarmed: [], error: extractErrorMessage(e) }))
      : throttled;
    const expiryAlerts = fullTick
      ? await runExpiryAlerts(Date.now()).catch((e) => ({ checked: -1, alerted: [], error: extractErrorMessage(e) }))
      : throttled;
    //  - price alerts: ADVISORY one-shot operator pings; independent of armed ladders.
    const priceAlerts = fullTick ? await checkPriceAlerts().catch(() => ({ checked: -1, fired: 0 })) : throttled;
    //  - scout watchdog: pages when the scout producer/consumer heartbeat goes stale.
    const scoutHeartbeats = fullTick ? await checkScoutHeartbeats().catch(() => ({ checked: -1, paged: 0 })) : throttled;
    //  - steward counterfactuals: scores due proposals ("would it have helped?") — 📊 pages.
    const stewardProposals = fullTick ? await resolveStewardProposals().catch(() => ({ checked: -1, resolved: 0 })) : throttled;
    //  - reversion alert: flag-gated (default OFF), fail-soft. DRAFT only — never arms.
    const reversionAlert = fullTick && isReversionAlertEnabled()
      ? await runReversionAlertCycle(undefined, Date.now()).catch((e) => ({ error: extractErrorMessage(e) }))
      : { skipped: fullTick ? 'disabled' : 'throttled' };
    //  - trend alert: flag-gated (default OFF), fail-soft. DRAFT only — never arms.
    //    (Its DISARM-side twin, the trend flip guard, runs UNthrottled before the tick.)
    const trendAlert = fullTick && isTrendAlertEnabled()
      ? await runTrendAlertCycle(undefined, Date.now()).catch((e) => ({ error: extractErrorMessage(e) }))
      : { skipped: fullTick ? 'disabled' : 'throttled' };
    //  - runaway alert ("strong movements ARE a catalyst", 08-19): on an outsized 24h
    //    move, auto-DRAFT a low-qty LIVE continuation ladder + 🚀 Discord the operator
    //    to panel-gate + arm. DRAFT only — NEVER arms. Flag-gated (default OFF), fail-soft.
    const runawayAlert = fullTick && isRunawayAlertEnabled()
      ? await runRunawayAlertCycle(undefined, Date.now()).catch((e) => ({ error: extractErrorMessage(e) }))
      : { skipped: fullTick ? 'disabled' : 'throttled' };
    //  - event-prep alert: 🚨 one deduped ping when a calendar macro event enters its
    //    prep window. 10-min granularity still lands ≥2 checks inside the 30-min lead.
    const eventPrepAlert = fullTick
      ? await runEventPrepAlert(Date.now()).catch((e) => ({ pinged: null, error: extractErrorMessage(e) }))
      : throttled;
    return NextResponse.json({ ok: true, ...summary, fullTick, leaderGuard, expiryAlerts, priceAlerts, scoutHeartbeats, stewardProposals, reversionAlert, trendAlert, runawayAlert, trendFlipGuard, eventPrepAlert });
  } catch (e) {
    await pingHealthcheck(hcUrl, 'fail');
    return NextResponse.json({ ok: false, error: extractErrorMessage(e) }, { status: 500 });
  }
}
