/**
 * GET /api/cockpit/stops — all resting reduce-only protective stops, keyed by coin.
 *
 * Read-only (admin-authed, no same-origin/rate-limit needed — it mutates nothing).
 * One HL `frontendOpenOrders` call backs the whole positions panel's protection
 * column, so each row can show ✓ stop / ⚠ no stop without an N-row fetch fan-out.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/infrastructure/auth/auth';
import { findAllStops } from '@/lib/trading/stop-order-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, stops: await findAllStops() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
}
