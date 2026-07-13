/**
 * GET /api/hl/regime?coin=ETH — server-cached COMBINED multi-timeframe candle
 * proxy for the right-rail regime strip. Coalesces the strip's 4 timeframe fetches
 * (1d/8h/1h/15m) into ONE round trip and one shared server cache, instead of the
 * browser firing four direct api.hyperliquid.xyz calls per poll per tab.
 *
 * Returns raw candles per interval; the PURE strip derivation (regime/confidence/
 * RSI in regime-strip-helpers) stays client-side and fixture-tested.
 */

import { NextRequest, NextResponse } from 'next/server';
import { guardHlRoute } from '../_guard';
import { fetchRegimeCandleSet } from '@/lib/hyperliquid/candle-service';

export const dynamic = 'force-dynamic';

const WINDOW_GRID_MS = 30_000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rejected = await guardHlRoute(request, 'hl-regime');
  if (rejected) return rejected;

  const coin = request.nextUrl.searchParams.get('coin')?.trim().toUpperCase() ?? '';
  if (!coin) return NextResponse.json({ ok: false, error: 'coin required' }, { status: 400 });

  // Coin-keyed regime candle set, memoized ~120s under its own
  // tag. The window is bucketed to the 30s grid inside the service so concurrent
  // polls share one cache key.
  const end = Math.floor(Date.now() / WINDOW_GRID_MS) * WINDOW_GRID_MS;
  const byInterval = await fetchRegimeCandleSet(coin, end);

  // Regime is slow-moving; hold it in the browser cache for 90s so the strip's
  // poll reads from cache (the multi-timeframe candle payload is large — serving
  // it from cache is the bulk of the regime egress saving).
  return NextResponse.json(
    { ok: true, byInterval },
    { headers: { 'Cache-Control': 'public, max-age=90, s-maxage=90, stale-while-revalidate=180' } },
  );
}
