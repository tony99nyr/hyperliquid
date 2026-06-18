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
import { fetchMultiTimeframeCandles } from '@/lib/hyperliquid/candle-service';
import { REGIME_STRIP_TIMEFRAMES } from '@/app/cockpit/components/right-rail/regime-strip-helpers';

export const dynamic = 'force-dynamic';

/** ~200d — enough for a 1d 50-period regime. Mirrors useRegimeStrip's lookback. */
const LOOKBACK_MS = 200 * 24 * 60 * 60 * 1000;
const WINDOW_GRID_MS = 30_000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rejected = await guardHlRoute(request, 'hl-regime');
  if (rejected) return rejected;

  const coin = request.nextUrl.searchParams.get('coin')?.trim().toUpperCase() ?? '';
  if (!coin) return NextResponse.json({ ok: false, error: 'coin required' }, { status: 400 });

  const end = Math.floor(Date.now() / WINDOW_GRID_MS) * WINDOW_GRID_MS;
  const byInterval = await fetchMultiTimeframeCandles(
    coin,
    [...REGIME_STRIP_TIMEFRAMES],
    end - LOOKBACK_MS,
    end,
  );

  return NextResponse.json(
    { ok: true, byInterval },
    { headers: { 'Cache-Control': 'private, max-age=20' } },
  );
}
