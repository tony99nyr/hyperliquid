/**
 * GET /api/cockpit/account-risk — real per-coin liquidation + effective leverage for
 * the operator's OWN HL account (reflects posted margin). Read-only, admin-gated. One
 * HL clearinghouse call backs the positions panel's true liq distance (the fold-based
 * formula ignores added margin).
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/infrastructure/auth/auth';
import { fetchAccountRisk } from '@/lib/trading/account-risk-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, risk: await fetchAccountRisk() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
}
