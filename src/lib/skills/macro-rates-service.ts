/**
 * Macro rates fetch (I/O) — FRED DGS30 daily CSV (keyless public endpoint), last ~6
 * weeks, folded by the pure read. Fail-soft null on any error/timeout: the macro line
 * is CONTEXT — its absence must never break a desk read.
 */

import {
  parseFredCsv,
  ratesRead,
  liquidityDashboard,
  type RatesRead,
  type LiquidityDashboard,
  type RatesPoint,
} from './macro-rates-business-logic';

const FRED_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';
const TIMEOUT_MS = 6_000;
const LOOKBACK_DAYS = 42;

async function fetchSeries(seriesId: string, now: number): Promise<RatesPoint[]> {
  try {
    const cosd = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${FRED_BASE}${seriesId}&cosd=${cosd}`, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) return [];
    return parseFredCsv(await res.text());
  } catch {
    return [];
  }
}

export async function fetch30yRead(now: number = Date.now()): Promise<RatesRead | null> {
  const pts = await fetchSeries('DGS30', now);
  return pts.length > 0 ? ratesRead(pts) : null;
}

/** The liquidity dashboard: 10Y (DGS10) + broad dollar (DTWEXBGS) + 10Y breakevens
 *  (T10YIE), fetched in parallel, each fail-soft empty. */
export async function fetchLiquidityDashboard(now: number = Date.now()): Promise<LiquidityDashboard> {
  const [y10, dxy, be] = await Promise.all([
    fetchSeries('DGS10', now),
    fetchSeries('DTWEXBGS', now),
    fetchSeries('T10YIE', now),
  ]);
  return liquidityDashboard(y10, dxy, be);
}
