/**
 * GET /api/cron/auto-exit — the Vercel-cron BACKUP detector (Layer 1).
 *
 * Dual-scheduler resilience: the NAS detector is primary (frequent), this cron is
 * the backup so a NAS outage doesn't leave positions unguarded. It lists every
 * open position and runs each through performRiskExit (which re-verifies + closes
 * only on a genuine trigger). The per-(session,coin) lock makes a NAS+cron race
 * fire at most once.
 *
 * Authed with the dedicated auto-exit cron token (set CRON_SECRET = the same value
 * so Vercel's auto-injected `Authorization: Bearer $CRON_SECRET` matches). Gated by
 * AUTO_EXIT_ENABLED (default OFF).
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronBearer } from '@/lib/infrastructure/auth/auth';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import { performRiskExit } from '@/lib/trading/risk-exit-service';
import { listExitCandidates } from '@/lib/auto-exit/auto-exit-scan';
import { isAutoExitEnabled, getAutoExitCronSecret, getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { scanAndAlertLiqProximity } from '@/lib/auto-exit/liq-alert-service';
import { getTradingMode } from '@/lib/env/mode';

export const dynamic = 'force-dynamic';

/** Hard cap on positions processed per cron tick (guards the function timeout). */
const MAX_CANDIDATES_PER_TICK = 40;

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Auth FIRST — the liq-alert scan reads the account, so it must be gated too.
  if (!verifyCronBearer(request, getAutoExitCronSecret())) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  // NOTIFY-ONLY liquidation-proximity alert. Runs EVERY tick, INDEPENDENT of the
  // gated auto-CLOSE below — so the operator gets paged (Discord) to Add margin even
  // when AUTO_EXIT_ENABLED is off. Never trades; a failure must not break the cron.
  let liqAlert: Awaited<ReturnType<typeof scanAndAlertLiqProximity>> | { error: string };
  try {
    liqAlert = await scanAndAlertLiqProximity(Date.now());
  } catch (e) {
    liqAlert = { error: extractErrorMessage(e) };
  }

  if (!isAutoExitEnabled()) {
    return NextResponse.json({ ok: true, skipped: 'auto-close disabled', liqAlert });
  }

  const all = await listExitCandidates();
  const candidates = all.slice(0, MAX_CANDIDATES_PER_TICK);
  const dropped = all.length - candidates.length;
  const results: Array<Record<string, unknown>> = [];
  for (const c of candidates) {
    try {
      const r = await performRiskExit({ sessionId: c.sessionId, coin: c.coin, now: Date.now() });
      results.push({ sessionId: c.sessionId, coin: c.coin, fired: r.fired, reason: r.reason, skipped: r.skipped });
    } catch (e) {
      results.push({ sessionId: c.sessionId, coin: c.coin, error: extractErrorMessage(e) });
    }
  }
  // Surface which triggers are actually LIVE so "I thought I had liq protection"
  // can't happen silently: liq-proximity + margin-% need clearinghouse data, which
  // needs live mode + HL_ACCOUNT_ADDRESS. Without it only loss-USD + health run.
  const liqMarginTriggers =
    getTradingMode() === 'live' && getHlAccountAddress()
      ? 'active'
      : 'DISABLED (needs live mode + HL_ACCOUNT_ADDRESS) — only loss-USD + health triggers run';

  return NextResponse.json({
    ok: true,
    scanned: candidates.length,
    dropped, // surfaced, never silently truncated
    fired: results.filter((r) => r.fired).length,
    coverage: { liqMarginTriggers },
    liqAlert,
    results,
  });
}
