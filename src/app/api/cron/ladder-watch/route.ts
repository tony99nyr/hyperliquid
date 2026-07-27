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
import { getLadderCronSecret, isReversionAlertEnabled, isTrendAlertEnabled } from '@/lib/ladder/ladder-flags';
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
    // Post-tick guards, all FAIL-SOFT (they must never break or fail the watcher tick):
    //  - leader guard: DISARM-ONLY — kills copy-thesis ladders whose leader exited/flipped.
    //  - expiry alert: ADVISORY — one page when an armed ladder nears expiry unfired.
    const leaderGuard = await runLeaderGuard(Date.now()).catch((e) => ({ checked: -1, disarmed: [], error: extractErrorMessage(e) }));
    const expiryAlerts = await runExpiryAlerts(Date.now()).catch((e) => ({ checked: -1, alerted: [], error: extractErrorMessage(e) }));
    //  - price alerts: ADVISORY one-shot operator pings; independent of armed ladders.
    const priceAlerts = await checkPriceAlerts().catch(() => ({ checked: -1, fired: 0 }));
    //  - scout watchdog: pages when the scout producer/consumer heartbeat goes stale
    //    (a dead scout box can't report itself; production must). Fail-soft.
    const scoutHeartbeats = await checkScoutHeartbeats().catch(() => ({ checked: -1, paged: 0 }));
    //  - steward counterfactuals: scores due proposals ("would it have helped?") — 📊 pages.
    const stewardProposals = await resolveStewardProposals().catch(() => ({ checked: -1, resolved: 0 }));
    //  - reversion alert: on a fresh reversion-extreme candidate, auto-DRAFT a low-qty
    //    LIVE fade ladder + 🔁 Discord the operator to review+arm. DRAFT only — NEVER arms
    //    (the human gate holds). Flag-gated (default OFF), fail-soft.
    const reversionAlert = isReversionAlertEnabled()
      ? await runReversionAlertCycle(undefined, Date.now()).catch((e) => ({ error: extractErrorMessage(e) }))
      : { skipped: 'disabled' };
    //  - trend alert (the iamrossi retired-leverage-lane replacement, fail-soft):
    //    8h stance bullish+confident+holding → auto-DRAFT a low-qty LIVE pyramiding
    //    ladder + 📈 Discord. DRAFT only — NEVER arms. Flag-gated (default OFF).
    //    (Its DISARM-side twin, the trend flip guard, runs BEFORE the tick above.)
    const trendAlert = isTrendAlertEnabled()
      ? await runTrendAlertCycle(undefined, Date.now()).catch((e) => ({ error: extractErrorMessage(e) }))
      : { skipped: 'disabled' };
    //  - event-prep alert: 🚨 pings the operator ONCE when a calendar macro event (FOMC,
    //    CPI…) enters its prep window, with the straddle:prep command. Advisory, deduped,
    //    fail-soft — never trades/arms/drafts.
    const eventPrepAlert = await runEventPrepAlert(Date.now()).catch((e) => ({ pinged: null, error: extractErrorMessage(e) }));
    return NextResponse.json({ ok: true, ...summary, leaderGuard, expiryAlerts, priceAlerts, scoutHeartbeats, stewardProposals, reversionAlert, trendAlert, trendFlipGuard, eventPrepAlert });
  } catch (e) {
    await pingHealthcheck(hcUrl, 'fail');
    return NextResponse.json({ ok: false, error: extractErrorMessage(e) }, { status: 500 });
  }
}
