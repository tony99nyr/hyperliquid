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
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import { performRiskExit } from '@/lib/trading/risk-exit-service';
import { listExitCandidates } from '@/lib/auto-exit/auto-exit-scan';
import { isAutoExitEnabled, getAutoExitCronSecret } from '@/lib/auto-exit/auto-exit-config';
import { bearerMatches } from '@/app/api/cockpit/risk-exit/route';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAutoExitEnabled()) {
    return NextResponse.json({ ok: true, skipped: 'disabled' });
  }
  if (!bearerMatches(request, getAutoExitCronSecret())) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const candidates = await listExitCandidates();
  const results: Array<Record<string, unknown>> = [];
  for (const c of candidates) {
    try {
      const r = await performRiskExit({ sessionId: c.sessionId, coin: c.coin, now: Date.now() });
      results.push({ sessionId: c.sessionId, coin: c.coin, fired: r.fired, reason: r.reason, skipped: r.skipped });
    } catch (e) {
      results.push({ sessionId: c.sessionId, coin: c.coin, error: extractErrorMessage(e) });
    }
  }
  return NextResponse.json({ ok: true, scanned: candidates.length, fired: results.filter((r) => r.fired).length, results });
}
