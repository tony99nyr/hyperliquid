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
import { getLadderCronSecret } from '@/lib/ladder/ladder-flags';
import { runLadderWatchTick } from '@/lib/ladder/ladder-watch-service';
import { runLeaderGuard } from '@/lib/ladder/ladder-leader-guard-service';
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
    const summary = await runLadderWatchTick({ now: Date.now() });
    // Post-tick guards, both FAIL-SOFT (they must never break or fail the watcher tick):
    //  - leader guard: DISARM-ONLY — kills copy-thesis ladders whose leader exited/flipped.
    const leaderGuard = await runLeaderGuard(Date.now()).catch((e) => ({ checked: -1, disarmed: [], error: extractErrorMessage(e) }));
    await pingHealthcheck(hcUrl, 'success');
    return NextResponse.json({ ok: true, ...summary, leaderGuard });
  } catch (e) {
    await pingHealthcheck(hcUrl, 'fail');
    return NextResponse.json({ ok: false, error: extractErrorMessage(e) }, { status: 500 });
  }
}
