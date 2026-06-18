/**
 * GET /api/hl/candles?coin=ETH&interval=1h&lookbackMs=... — server-cached candle
 * proxy for the live chart. Fronts HL `candleSnapshot` so the browser reads
 * candles through OUR server (shared 30s cache + global 429 backoff) instead of
 * every tab hitting api.hyperliquid.xyz directly.
 *
 * Why this kills the 429s: the in-process cache in candle-service is now shared by
 * ALL browser clients (one server) AND coalesces concurrent identical windows, so
 * N polling tabs collapse to ~1 upstream call per (coin, interval) per TTL. A 429
 * from HL flips a process-wide backoff that quiets the whole fleet.
 */

import { NextRequest, NextResponse } from 'next/server';
import { guardHlRoute } from '../_guard';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { isSupportedInterval } from '@/lib/hyperliquid/candle-service-business-logic';

export const dynamic = 'force-dynamic';

/** Snap the window to a TTL-aligned boundary so concurrent tabs request the SAME
 *  key (cache hit) instead of slightly-different `Date.now()` windows (cache miss
 *  every time). 30s grid matches the candle cache TTL. */
const WINDOW_GRID_MS = 30_000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rejected = await guardHlRoute(request, 'hl-candles');
  if (rejected) return rejected;

  const sp = request.nextUrl.searchParams;
  const coin = sp.get('coin')?.trim().toUpperCase() ?? '';
  const interval = sp.get('interval')?.trim() ?? '';
  const lookbackMs = Number(sp.get('lookbackMs') ?? '');

  if (!coin) return NextResponse.json({ ok: false, error: 'coin required' }, { status: 400 });
  if (!isSupportedInterval(interval)) {
    return NextResponse.json({ ok: false, error: `unsupported interval ${interval}` }, { status: 400 });
  }
  if (!Number.isFinite(lookbackMs) || lookbackMs <= 0) {
    return NextResponse.json({ ok: false, error: 'lookbackMs required' }, { status: 400 });
  }

  const end = Math.floor(Date.now() / WINDOW_GRID_MS) * WINDOW_GRID_MS;
  const result = await fetchCandles(coin, interval, end - lookbackMs, end);

  // Let the browser/edge hold the response briefly too (second cache layer): the
  // candles are valid for the TTL window and this further trims upstream load.
  return NextResponse.json(
    { ok: true, result },
    { headers: { 'Cache-Control': 'private, max-age=15' } },
  );
}
