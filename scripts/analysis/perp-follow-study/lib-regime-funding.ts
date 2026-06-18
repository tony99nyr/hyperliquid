/**
 * Regime-gate + funding adapters for Part B.
 *  - Loads OUR HL daily ETH/BTC candles, runs detectMarketRegimeCached at the
 *    daily index whose close is the last completed candle at/just before a ts.
 *  - Loads realized hourly funding (HL) and integrates it over a holding interval,
 *    sign-correct for long vs short.
 */
import * as fs from 'fs';
import { detectMarketRegimeCached } from '@/lib/strategy/analysis/market-regime-detector-cached';
import { DEFAULT_REGIME_DETECTION_CONFIG } from '@/lib/strategy/config/regime-detection-config';
import type { PriceCandle } from '@/types';
import type { MarketRegime } from '@/lib/strategy/analysis/market-regime-detector-cached';
import { PATHS } from './study-config';

interface RawDaily { t: number; o: string; h: string; l: string; c: string; v: string }
interface RawFunding { coin: string; fundingRate: string; time: number }

function loadDaily(coin: 'ETH' | 'BTC'): PriceCandle[] {
  const raw = JSON.parse(fs.readFileSync(`${PATHS.FUNDING_DIR}/hl_candles_1d_${coin}.json`, 'utf8')) as RawDaily[];
  return raw
    .map((c) => ({ timestamp: c.t, open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

const dailyCache: Record<string, PriceCandle[]> = {};
function daily(coin: 'ETH' | 'BTC'): PriceCandle[] {
  if (!dailyCache[coin]) dailyCache[coin] = loadDaily(coin);
  return dailyCache[coin];
}

/** Index of the last daily candle whose timestamp <= ts. */
function dailyIndexAt(coin: 'ETH' | 'BTC', ts: number): number {
  const c = daily(coin);
  let idx = -1;
  // binary search last timestamp <= ts
  let lo = 0, hi = c.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid].timestamp <= ts) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx;
}

export interface RegimeAt { regime: MarketRegime; confidence: number }

/** OUR regime at a fill timestamp, on OUR daily candles, prod config. */
export function regimeAt(coin: 'ETH' | 'BTC', ts: number): RegimeAt | null {
  const idx = dailyIndexAt(coin, ts);
  if (idx < 50) return null;
  const sig = detectMarketRegimeCached(daily(coin), idx, DEFAULT_REGIME_DETECTION_CONFIG);
  return { regime: sig.regime, confidence: sig.confidence };
}

// ---- funding ----
const fundingCache: Record<string, Array<[number, number]>> = {};
function funding(coin: 'ETH' | 'BTC'): Array<[number, number]> {
  if (!fundingCache[coin]) {
    const raw = JSON.parse(fs.readFileSync(`${PATHS.FUNDING_DIR}/hl_funding_${coin}.json`, 'utf8')) as RawFunding[];
    fundingCache[coin] = raw.map((r) => [r.time, parseFloat(r.fundingRate)] as [number, number]).sort((a, b) => a[0] - b[0]);
  }
  return fundingCache[coin];
}

/**
 * Realized funding COST as a fraction of notional over [openTs, closeTs] for a
 * LONG. Returns the sum of hourly fundingRate over the interval. Positive => long
 * pays. For a SHORT, the cost is the negative of this.
 */
export function fundingFractionLong(coin: 'ETH' | 'BTC', openTs: number, closeTs: number): number {
  const f = funding(coin);
  let sum = 0;
  // HL funding is charged hourly; sum rates whose timestamp is within [open, close)
  let lo = 0, hi = f.length - 1, startIdx = f.length;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (f[mid][0] >= openTs) { startIdx = mid; hi = mid - 1; } else lo = mid + 1; }
  for (let i = startIdx; i < f.length && f[i][0] < closeTs; i++) sum += f[i][1];
  return sum; // long pays `sum`*notional
}

export function priceAt(coin: 'ETH' | 'BTC', ts: number): number | null {
  const idx = dailyIndexAt(coin, ts);
  if (idx < 0) return null;
  return daily(coin)[idx].close;
}

/** Intraday-ish price via daily close interpolation (we only have daily candles for OUR price). */
export function priceCloseSeries(coin: 'ETH' | 'BTC'): PriceCandle[] {
  return daily(coin);
}

// ---- 1h price series (finer entry/exit pricing for Part B) ----
interface Raw1h { t: number; o: string; c: string; h: string; l: string; v: string }
const hourlyCache: Record<string, Array<[number, number]>> = {};
function hourly(coin: 'ETH' | 'BTC'): Array<[number, number]> {
  if (!hourlyCache[coin]) {
    const raw = JSON.parse(fs.readFileSync(`${PATHS.HL_DIR}/candles/${coin}_1h_full.json`, 'utf8')) as Raw1h[];
    hourlyCache[coin] = raw.map((c) => [c.t, parseFloat(c.c)] as [number, number]).sort((a, b) => a[0] - b[0]);
  }
  return hourlyCache[coin];
}

/** Close of the 1h candle at/just before ts. Falls back to daily if outside 1h range. */
export function priceAt1h(coin: 'ETH' | 'BTC', ts: number): number | null {
  const h = hourly(coin);
  if (!h.length || ts < h[0][0]) return priceAt(coin, ts); // before 1h coverage -> daily
  let idx = -1, lo = 0, hi = h.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (h[mid][0] <= ts) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx >= 0 ? h[idx][1] : priceAt(coin, ts);
}
