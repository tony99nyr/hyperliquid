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
import { timingSafeEqual } from 'node:crypto';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import { buildMarketStateAdvisory } from '@/lib/advisory/market-state-service';

export const dynamic = 'force-dynamic';

/** The consumers are crons (8h + 30min) — 10/min per client is generous. */
const MAX_PER_MIN = 10;

/**
 * Dedicated READ-scoped bearer (ADVISORY_READ_TOKEN) so the consuming system
 * never has to hold this cockpit's ADMIN_SECRET — a compromise over there must
 * not be able to hit approve/arm/exit routes here. Constant-time compare;
 * unset/short token disables the path (admin auth still works).
 */
function hasAdvisoryReadToken(request: NextRequest): boolean {
  const expected = process.env.ADVISORY_READ_TOKEN;
  if (!expected || expected.length < 16) return false;
  const auth = request.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!hasAdvisoryReadToken(request) && !(await verifyAdminAuth(request))) {
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
