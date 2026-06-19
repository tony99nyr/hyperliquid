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
import { isAutoExitEnabled, getAutoExitCronSecret } from '@/lib/auto-exit/auto-exit-config';

export const dynamic = 'force-dynamic';

/** Hard cap on positions processed per cron tick (guards the function timeout). */
const MAX_CANDIDATES_PER_TICK = 40;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAutoExitEnabled()) {
    return NextResponse.json({ ok: true, skipped: 'disabled' });
  }
  if (!verifyCronBearer(request, getAutoExitCronSecret())) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
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
  return NextResponse.json({
    ok: true,
    scanned: candidates.length,
    dropped, // surfaced, never silently truncated
    fired: results.filter((r) => r.fired).length,
    results,
  });
}
