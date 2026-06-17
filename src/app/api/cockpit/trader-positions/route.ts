/**
 * GET /api/cockpit/trader-positions?address=0x… — a rated trader's LIVE open
 * positions (Hyperliquid clearinghouseState), fetched ON DEMAND when the operator
 * opens the trader-detail drawer.
 *
 * READ-ONLY: this proxies the public HL info endpoint (no key, no order-placement
 * anywhere). It exists so the heavy fetch happens server-side (consistent caching
 * + no CORS) rather than from the browser. Admin-authed (same gate as the page).
 *
 * Hardened (mirrors approve/reject): after admin auth we ALSO same-origin + rate
 * limit BEFORE touching HL, so an authed-but-leaked session can't iterate
 * addresses and hammer the upstream info endpoint. 403 cross-origin, 429 overrate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import {
  fetchClearinghouseState,
  isValidHlAddress,
} from '@/lib/hyperliquid/hyperliquid-info-service';

export const dynamic = 'force-dynamic';

/** Read-only proxy, but each call is a real upstream HL fetch: 30/min per client. */
const TRADER_POSITIONS_MAX_PER_MIN = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 1) Auth FIRST (an unauthenticated caller always gets 401).
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  // 2) Same-origin: a leaked admin cookie on a hostile page can't drive this.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  // 3) Rate limit BEFORE the HL fetch — stop address-iteration / hammering.
  const limit = checkRateLimit(
    `trader-positions:${getClientIdentifier(request)}`,
    TRADER_POSITIONS_MAX_PER_MIN,
    60_000,
  );
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }

  const address = request.nextUrl.searchParams.get('address')?.trim() ?? '';
  if (!isValidHlAddress(address)) {
    return NextResponse.json({ ok: false, error: 'Invalid Hyperliquid address' }, { status: 400 });
  }
  const state = await fetchClearinghouseState(address);
  return NextResponse.json({ ok: true, state });
}
