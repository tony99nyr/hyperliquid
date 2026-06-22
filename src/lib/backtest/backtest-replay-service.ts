/**
 * Backtest replay (I/O) — fetch historical HL candles and drive the PURE
 * simulator off the REGIME/TREND core: enter when the regime is confirmed
 * (confidence ≥ threshold) on a bar, with rubric-derived levels (deriveLevels),
 * then simulate with realistic frictions. This is deliberately the LEADERS-ABLATION
 * test the review asked for — leaders/carry/micro are NOT involved; it measures
 * whether the regime/trend core alone has edge on historical price.
 *
 * Honest scope / data limits: single timeframe (the fetched interval, default 1h);
 * no historical L2 book (fills modeled by adverse-slippage on the bar price); no
 * historical funding (flat 0 — carry excluded). It answers "does the trend core
 * pay after frictions?", NOT "does the full multi-pillar rubric pay" (that needs
 * historical book/leader/funding the system only started logging via market_snapshots).
 */

import { fetchCandles, fetchFundingHistory, fundingRateAt, type CandleInterval, type FundingPoint } from '@/lib/hyperliquid/candle-service';
import { detectMarketRegime } from '@/lib/strategy/analysis/market-regime-detector';
import { calculateATR, calculateBollingerBands } from '@/lib/strategy/indicators/indicators';
import type { PriceCandle } from '@/types/trading-core';
import { loadRubricConfig, resolveCoinConfig } from '@/lib/rubric/rubric-config';
import { deriveLevels } from '@/lib/rubric/rubric-gates-business-logic';
import { baseSlippageBps } from '@/lib/trading/paper-fill-realism-business-logic';
import { simulateBacktest, type BacktestBar, type BacktestResult } from './backtest-business-logic';
import { buildScorecard, type Scorecard } from '@/lib/scout/scout-review-business-logic';

const INTERVAL_HOURS: Record<string, number> = { '15m': 0.25, '1h': 1, '4h': 4, '8h': 8, '1d': 24 };
const WARMUP_BARS = 60; // regime + ATR need history before the first signal

/** Fraction of finite values ≤ the last (the rubric's percentile rank; flat → 0.5). */
function pctRankLast(series: number[]): number {
  const finite = series.filter((v) => Number.isFinite(v));
  if (finite.length <= 1 || finite.every((v) => v === finite[0])) return 0.5;
  const last = finite[finite.length - 1];
  return finite.filter((v) => v <= last).length / finite.length;
}

/** Per-bar vol-contraction read (ATR + Bollinger-bandwidth percentiles) over a
 *  trailing window — the rubric's chop detector, computed point-in-time for bar i. */
function volContractionAt(candles: PriceCandle[], i: number, lookback = 120): { atrPctile: number; bbPctile: number } {
  const w = candles.slice(Math.max(0, i - lookback), i + 1);
  if (w.length < 30) return { atrPctile: 0.5, bbPctile: 0.5 };
  const atr = calculateATR(w, 14, true);
  const closes = w.map((c) => c.close);
  const bb = calculateBollingerBands(closes, 20, 2);
  const bw = bb.middle.map((m, j) => (m > 0 ? (bb.upper[j] - bb.lower[j]) / m : 0));
  return { atrPctile: pctRankLast(atr), bbPctile: pctRankLast(bw) };
}

export interface BacktestOptions {
  coin: string;
  days: number;
  interval?: CandleInterval;
  /** Regime confidence to call a bar "confirmed" (drives entries). Lower = earlier. */
  confThreshold?: number;
  /** Override the ATR stop multiplier (default from config) — wider = more room. */
  stopAtrMult?: number;
  /** Override the ATR target multiplier (default from config). */
  targetAtrMult?: number;
  /** FADE mode: enter OPPOSITE the confirmed regime (mean-reversion hypothesis). */
  fade?: boolean;
  /** Execution model — 'maker' tests passive entries + rebate (the friction fix). */
  fillModel?: 'taker' | 'maker';
  /** Maker realism: queue-clearance bps (price must trade through to fill). */
  makerQueueClearBps?: number;
  /** Maker realism: adverse-selection penalty bps on a maker fill. */
  makerAdverseSelBps?: number;
  /** As-of END of the window (epoch ms) for OOS/walk-forward testing; default now. */
  endMs?: number;
  /** SIT OUT CHOP: skip entries when in vol-contraction (the rubric's chop gate). */
  sitOutChop?: boolean;
  /** Exit policy: 'trail' lets winners run (ratcheting ATR stop, no fixed target). */
  exitMode?: 'fixed' | 'trail';
  /** Trailing-stop distance in ATRs (trail mode only). */
  trailAtrMult?: number;
  /** Model real HL funding (longs pay / shorts earn) instead of the flat-0 default. */
  applyFunding?: boolean;
  notionalUsd?: number;
}

export interface BacktestRunResult {
  coin: string;
  interval: string;
  bars: number;
  signals: number; // bars that were a confirmed GO
  periodDays: number;
  /** The window's buy-and-hold price move (first→last close, %) — the regime proxy. */
  priceMovePct: number;
  windowEndMs: number;
  result: BacktestResult;
  scorecard: Scorecard;
}

export async function runBacktest(opts: BacktestOptions): Promise<BacktestRunResult> {
  const coin = opts.coin.toUpperCase();
  const interval = opts.interval ?? '1h';
  const barHours = INTERVAL_HOURS[interval] ?? 1;
  const confThreshold = opts.confThreshold ?? 0.5;
  const notionalUsd = opts.notionalUsd ?? 1000;
  const baseCfg = resolveCoinConfig(loadRubricConfig(), coin);
  // Apply level overrides (mechanism study) without mutating the loaded config.
  const cfg = {
    ...baseCfg,
    levels: {
      ...baseCfg.levels,
      stopAtrMult: opts.stopAtrMult ?? baseCfg.levels.stopAtrMult,
      targetAtrMult: opts.targetAtrMult ?? baseCfg.levels.targetAtrMult,
    },
  };

  const endMs = opts.endMs ?? Date.now();
  const start = endMs - opts.days * 24 * 60 * 60 * 1000;
  const { candles } = await fetchCandles(coin, interval, start, endMs);
  if (candles.length < WARMUP_BARS + 5) {
    throw new Error(`backtest: too few ${interval} candles for ${coin} (${candles.length}); widen --days or pick a window with data.`);
  }
  const priceMovePct = candles.length > 1 ? ((candles[candles.length - 1].close - candles[0].close) / candles[0].close) * 100 : 0;

  // Real funding (carry) — longs pay, shorts earn. Off by default (flat 0) to keep
  // the directional check clean; --funding turns it on for the honesty/carry study.
  const funding: FundingPoint[] = opts.applyFunding ? await fetchFundingHistory(coin, start, endMs) : [];

  // ATR aligned to candle indices (offset = first index that has an ATR value).
  const atrSeries = calculateATR(candles, 14, true);
  const atrOffset = candles.length - atrSeries.length;

  const bars: BacktestBar[] = [];
  let signals = 0;
  for (let i = WARMUP_BARS; i < candles.length; i++) {
    const c = candles[i];
    const regime = detectMarketRegime(candles, i);
    const atr = atrSeries[i - atrOffset] ?? 0;
    let confirmed = regime.regime !== 'neutral' && regime.confidence >= confThreshold && atr > 0;
    // SIT OUT CHOP: skip when in vol-contraction (both ATR + BB-bandwidth percentiles
    // below the rubric's contraction thresholds) — the proven chop-avoidance skill.
    if (confirmed && opts.sitOutChop) {
      const vc = volContractionAt(candles, i);
      if (vc.atrPctile < cfg.gates.volContractionAtrPctile && vc.bbPctile < cfg.gates.volContractionBbPctile) confirmed = false;
    }
    // FADE mode trades AGAINST the regime (mean-reversion); default trades WITH it.
    const trendSide = regime.regime === 'bullish' ? 'long' : 'short';
    const side = !confirmed ? 'none' : opts.fade ? (trendSide === 'long' ? 'short' : 'long') : trendSide;
    const levels = side === 'none' ? null : deriveLevels(c.close, atr, side, cfg);
    if (confirmed) signals++;
    bars.push({
      time: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      side,
      go: confirmed,
      confidence: regime.confidence,
      atr,
      invalidation: levels?.invalidation ?? 0,
      target: levels?.target ?? 0,
      fundingHourly: opts.applyFunding ? fundingRateAt(funding, c.timestamp) : 0,
    });
  }

  const result = simulateBacktest(bars, {
    slippageBps: baseSlippageBps(coin),
    barHours,
    notionalUsd,
    fillModel: opts.fillModel,
    makerQueueClearBps: opts.makerQueueClearBps,
    makerAdverseSelBps: opts.makerAdverseSelBps,
    exitMode: opts.exitMode,
    trailAtrMult: opts.trailAtrMult,
  });

  const periodDays = opts.days;
  const scorecard = buildScorecard({
    realizedGrossUsd: result.netUsd, // already net of slippage + funding in the sim
    slippageHaircutUsd: 0,
    fundingHaircutUsd: 0,
    tradeCount: result.trades.length,
    wins: result.wins,
    losses: result.losses,
    periodDays,
    maxDrawdownUsd: result.maxDrawdownUsd,
    equityUsd: notionalUsd, // DD as a fraction of the per-trade notional (proxy)
  });

  return { coin, interval, bars: bars.length, signals, periodDays, priceMovePct, windowEndMs: endMs, result, scorecard };
}
