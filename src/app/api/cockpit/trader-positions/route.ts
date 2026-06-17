/**
 * GET /api/cockpit/trader-positions?address=0x… — a rated trader's LIVE open
 * positions (Hyperliquid clearinghouseState), fetched ON DEMAND when the operator
 * opens the trader-detail drawer.
 *
 * READ-ONLY: this proxies the public HL info endpoint (no key, no order-placement
 * anywhere). It exists so the heavy fetch happens server-side (consistent caching
 * + no CORS) rather than from the browser. Admin-authed (same gate as the page).
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/infrastructure/auth/auth';
import {
  fetchClearinghouseState,
  isValidHlAddress,
} from '@/lib/hyperliquid/hyperliquid-info-service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const address = request.nextUrl.searchParams.get('address')?.trim() ?? '';
  if (!isValidHlAddress(address)) {
    return NextResponse.json({ ok: false, error: 'Invalid Hyperliquid address' }, { status: 400 });
  }
  const state = await fetchClearinghouseState(address);
  return NextResponse.json({ ok: true, state });
}
