/**
 * GET /api/cron/reconcile-positions — keep the cockpit's positions in lock-step with
 * the REAL Hyperliquid account. Reads HL clearinghouseState and flattens/resyncs any
 * cockpit LIVE-session position that drifted (e.g. a manual close in the HL app, a
 * partial fill, or a liquidation the cockpit never recorded). Read-only on HL;
 * service-role writes to Supabase. NEVER trades.
 *
 * Runs server-side on Vercel (where HL_ACCOUNT_ADDRESS lives) and is poked by the NAS
 * (same CRON_SECRET as the auto-exit poke). NOT gated by AUTO_EXIT_ENABLED — this is a
 * data sync, not an order. Safe to run continuously: a stale HL read short-circuits to
 * a no-op (never flattens real positions on a transient error).
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronBearer } from '@/lib/infrastructure/auth/auth';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import { getAutoExitCronSecret } from '@/lib/auto-exit/auto-exit-config';
import { reconcileLivePositions } from '@/lib/cockpit/position-reconcile-service';
import { backfillExchangeFills } from '@/lib/cockpit/fill-backfill-service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronBearer(request, getAutoExitCronSecret())) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    // Backfill FIRST: booking the exchange-side fills the ledger missed lets the
    // position fold correct rows WITH their history; the reconciler then only
    // handles residual drift (and its freshness guards still apply).
    const backfill = await backfillExchangeFills();
    const summary = await reconcileLivePositions();
    return NextResponse.json({ ok: true, ...summary, backfill });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(e) }, { status: 500 });
  }
}
