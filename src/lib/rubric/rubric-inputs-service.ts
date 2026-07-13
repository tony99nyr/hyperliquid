/**
 * Rubric INPUTS assembly (I/O). Gathers everything computeRubric needs for one
 * coin, point-in-time: multi-TF regime (clearing the indicator cache between TFs
 * — the known cache-collision bug), ATR + vol percentiles, the live mark, the
 * order book, funding/OI, and leader consensus read from the already-populated
 * leader_positions table (NO per-leader HL fan-out). Pure scoring lives in the
 * business-logic; this only fetches + adapts.
 */

import { fetchMultiTimeframeCandles, type CandleInterval } from '@/lib/hyperliquid/candle-service';
import { detectMarketRegimeCached, clearIndicatorCache } from '@/lib/strategy/analysis/market-regime-detector-cached';
import { calculateATR, calculateBollingerBands } from '@/lib/strategy/indicators/indicators';
import { fetchAllMids, fetchL2Book, fetchMetaAndAssetCtxs, fetchRecentTrades, type HlAssetCtx } from '@/lib/hyperliquid/hyperliquid-info-service';
import { takerFlowFromTrades, scoreBookImbalance } from './rubric-scorers-business-logic';
import { getTopTraders } from '@/lib/hyperliquid/top-traders-service';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { validateEnv } from '@/lib/env/env';
import type { PriceCandle } from '@/types/trading-core';
import type { HealthTimeframe } from '@/lib/health/health-engine-types';
import type { MarketRegimeSignal } from '@/lib/strategy/analysis/market-regime-detector-cached';
import type { RubricConfig } from './rubric-config-types';
import { loadRubricConfig, resolveCoinConfig } from './rubric-config';
import { aggregateLeaderConsensus } from './rubric-scorers-business-logic';
import type { AssetCtx, LeaderConsensus, LeaderPosForCoin, RubricInputs } from './rubric-types';

const DAY = 86_400_000;
const LOOKBACK_MS: Record<HealthTimeframe, number> = {
  '1d': 200 * DAY,
  '8h': 80 * DAY,
  '1h': 20 * DAY,
  '15m': 5 * DAY,
};
const TFS: HealthTimeframe[] = ['1d', '8h', '1h', '15m'];

/** Percentile rank of the last value within a trailing window (fraction ≤ it). */
function percentileRankLast(series: number[], lookback = 100): number {
  if (series.length === 0) return 0.5;
  const window = series.slice(-lookback);
  const last = window[window.length - 1];
  if (!Number.isFinite(last)) return 0.5;
  const finite = window.filter((v) => Number.isFinite(v));
  // Dead-flat (or single-value) series has no percentile signal — every value is
  // ≤ last, which would otherwise report a misleading 1.0 (max vol). Treat as neutral.
  if (finite.length <= 1 || finite.every((v) => v === finite[0])) return 0.5;
  const le = finite.filter((v) => v <= last).length;
  return le / finite.length;
}

/** ATR (absolute) + ATR percentile + Bollinger-bandwidth percentile from 1h candles. */
function volMetrics(candles1h: PriceCandle[]): { atr: number; atrPctile: number; bbPctile: number } {
  if (candles1h.length < 30) return { atr: 0, atrPctile: 0.5, bbPctile: 0.5 };
  const atrSeries = calculateATR(candles1h, 14, true);
  const atr = atrSeries[atrSeries.length - 1] ?? 0;
  const closes = candles1h.map((c) => c.close);
  const bb = calculateBollingerBands(closes, 20, 2);
  const bandwidth = bb.middle.map((m, i) => (m > 0 ? (bb.upper[i] - bb.lower[i]) / m : 0));
  return { atr, atrPctile: percentileRankLast(atrSeries), bbPctile: percentileRankLast(bandwidth) };
}

/** Multi-TF regime, clearing the indicator cache between TFs (avoids the collision bug). */
async function regimeByTf(coin: string, now: number): Promise<{
  regimeByTf: Partial<Record<HealthTimeframe, MarketRegimeSignal>>;
  candles1h: PriceCandle[];
}> {
  const out: Partial<Record<HealthTimeframe, MarketRegimeSignal>> = {};
  let candles1h: PriceCandle[] = [];
  for (const tf of TFS) {
    const res = await fetchMultiTimeframeCandles(coin, [tf as CandleInterval], now - LOOKBACK_MS[tf], now);
    const candles = res[tf]?.candles ?? [];
    if (tf === '1h') candles1h = candles;
    if (candles.length < 50) continue; // not enough history for a meaningful regime
    clearIndicatorCache(); // CRITICAL: each TF is a distinct dataset
    out[tf] = detectMarketRegimeCached(candles, candles.length - 1);
  }
  return { regimeByTf: out, candles1h };
}

interface LeaderPositionRow {
  leader_address: string;
  side: 'long' | 'short';
  position_value: number | null;
  account_value_usd: number | null;
  updated_at: string | null;
}

/** Leader consensus for a coin from leader_positions (Supabase) + clean-book flags. */
async function leaderConsensus(coin: string, cfg: RubricConfig, now: number): Promise<LeaderConsensus> {
  const empty: LeaderConsensus = { coin, net: 0, longCount: 0, shortCount: 0, topN: 0 };
  let client;
  try {
    client = getServiceRoleClient();
  } catch {
    return empty;
  }
  const { data, error } = await client
    .from('leader_positions')
    .select('leader_address, side, position_value, account_value_usd, updated_at')
    .eq('coin', coin.toUpperCase());
  if (error || !Array.isArray(data) || data.length === 0) return empty;

  // Clean-book set from the rated universe (large limit so most leaders resolve).
  const clean = new Set(getTopTraders(500).filter((t) => t.cleanBook).map((t) => t.address.toLowerCase()));

  const positions: LeaderPosForCoin[] = (data as LeaderPositionRow[]).map((row) => {
    const acct = row.account_value_usd ?? 0;
    const pv = row.position_value ?? 0;
    // Conviction = position size vs account (capped); fallback 1 when account unknown.
    const conviction = acct > 0 ? Math.min(3, pv / acct) : 1;
    // Freshness = age of OUR snapshot (updated_at), so a stale leader feed (dead
    // watcher) decays toward 0 instead of counting as maximally fresh — fixes the
    // hardcoded no-op. NOTE: this is DATA-snapshot age, not the leader's hold-age;
    // true position-hold decay needs leader_actions.detected_at (a follow-up).
    const ageMs = row.updated_at ? now - new Date(row.updated_at).getTime() : 0;
    const freshnessHours = Number.isFinite(ageMs) && ageMs > 0 ? ageMs / 3_600_000 : 0;
    return {
      side: row.side,
      conviction: Number.isFinite(conviction) && conviction > 0 ? conviction : 1,
      freshnessHours,
      cleanBook: clean.has(row.leader_address.toLowerCase()),
    };
  });
  return aggregateLeaderConsensus(coin, positions, cfg);
}

/** Assemble the full RubricInputs for one coin. Returns null if the mark is unavailable. */
export async function assembleInputs(coin: string, now: number): Promise<RubricInputs | null> {
  const upper = coin.toUpperCase();
  const cfg = resolveCoinConfig(loadRubricConfig(), upper);
  const network = validateEnv().HL_NETWORK;

  const [mids, book, ctxs, regime, consensus, trades] = await Promise.all([
    fetchAllMids(network).catch(() => ({}) as Record<string, number>),
    fetchL2Book(upper).catch(() => ({ coin: upper, bids: [], asks: [] })),
    fetchMetaAndAssetCtxs(network).catch(() => ({}) as Record<string, HlAssetCtx>),
    regimeByTf(upper, now),
    leaderConsensus(upper, cfg, now),
    fetchRecentTrades(upper).catch(() => []), // fail-soft [] (belt: fn also never rejects)
  ]);

  const markPx = mids[upper];
  if (!Number.isFinite(markPx) || markPx <= 0) return null;

  const { atr, atrPctile, bbPctile } = volMetrics(regime.candles1h);
  const rawCtx = ctxs[upper];
  const ctx: AssetCtx | null = rawCtx
    ? {
        coin: upper,
        fundingHourly: rawCtx.fundingHourly,
        openInterest: rawCtx.openInterest,
        premium: rawCtx.premium,
        markPx: rawCtx.markPx || markPx,
        oraclePx: rawCtx.oraclePx || markPx,
      }
    : null;

  return {
    coin: upper,
    asOf: now,
    markPx,
    regimeByTf: regime.regimeByTf,
    atrPctile,
    bbBandwidthPctile: bbPctile,
    atr: atr > 0 ? atr : markPx * 0.01, // fallback ~1% if ATR unavailable
    book,
    takerFlow: takerFlowFromTrades(trades),
    bookImbalance: scoreBookImbalance(book, cfg.gates.depthQueryFrac).imbalance,
    consensus,
    ctx,
  };
}
