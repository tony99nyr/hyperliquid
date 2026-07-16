/**
 * GET /api/advisory/market-state?coins=ETH,BTC — the cross-system advisory feed.
 *
 * Consumed by the iamrossi trend system (AI-verifier context + risk-monitor
 * event warnings) with `Authorization: Bearer <ADMIN_SECRET>`. READ-ONLY: this
 * route can never execute, arm, or write anything. Consumers are contractually
 * fail-open — an error here must never block a trade decision over there, so
 * the route itself also degrades per-section rather than 500ing on partial data.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import { buildMarketStateAdvisory } from '@/lib/advisory/market-state-service';

export const dynamic = 'force-dynamic';

/** The consumers are crons (8h + 30min) — 10/min per client is generous. */
const MAX_PER_MIN = 10;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const limit = checkRateLimit(`advisory:${getClientIdentifier(request)}`, MAX_PER_MIN, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }
  const coinsParam = request.nextUrl.searchParams.get('coins') ?? 'ETH,BTC';
  try {
    const advisory = await buildMarketStateAdvisory(coinsParam.split(','));
    return NextResponse.json({ ok: true, ...advisory });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(e) }, { status: 500 });
  }
}
