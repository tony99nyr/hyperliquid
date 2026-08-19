/**
 * Macro rates fetch (I/O) — FRED DGS30 daily CSV (keyless public endpoint), last ~6
 * weeks, folded by the pure read. Fail-soft null on any error/timeout: the macro line
 * is CONTEXT — its absence must never break a desk read.
 */

import { parseFredCsv, ratesRead, type RatesRead } from './macro-rates-business-logic';

const FRED_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS30';
const TIMEOUT_MS = 6_000;
const LOOKBACK_DAYS = 42;

export async function fetch30yRead(now: number = Date.now()): Promise<RatesRead | null> {
  try {
    const cosd = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${FRED_URL}&cosd=${cosd}`, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) return null;
    return ratesRead(parseFredCsv(await res.text()));
  } catch {
    return null;
  }
}
