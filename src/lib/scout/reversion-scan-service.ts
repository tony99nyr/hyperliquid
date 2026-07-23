/**
 * Reversion-extreme scan (I/O) — the ONE place that fetches candles and runs the
 * PURE `reversionSignal` + 4h regime gate for a set of coins. Extracted so BOTH
 * consumers share identical logic:
 *   - the cycle snapshot (scripts/scout-cycle.ts) — surfaces the REVERSION section
 *     to the woken model;
 *   - the trigger daemon (scout-watch-service) — wakes the model the MOMENT a
 *     |z|≥2.5 stretch prints, instead of only when a cycle happens to run.
 *
 * READ-ONLY. Fail-soft per coin (a candle blip drops that coin, never the scan).
 * The candle fetcher is injectable so the orchestration/gating is unit-testable
 * without HL I/O; the pure decisions (`reversionSignal`, `detectMarketRegime`) are
 * already fixture-tested in their own modules.
 */

import type { CandleInterval } from '@/lib/hyperliquid/candle-service';
import type { PriceCandle } from '@/types/trading-core';
import { reversionSignal, type RegimeGate } from './reversion-signal-business-logic';
import { detectMarketRegime } from '@/lib/strategy/analysis/market-regime-detector';

export interface ReversionHit {
  coin: string;
  side: 'long' | 'short';
  z: number;
  er: number;
  regime: string;
  regimeConf: number;
  mark: number;
  stop: number;
  target: number;
  stopFrac: number;
}

export interface RegimeRead {
  regime: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  trend: number;
}

/** The scan consumes full PriceCandles: the 4h regime detector needs open/volume/
 *  timestamp, and the 15m reversion signal reads high/low/close. */
export type ScanCandleFetch = (
  coin: string,
  interval: CandleInterval,
  startMs: number,
  endMs: number,
) => Promise<{ stale: boolean; candles: PriceCandle[] }>;

export interface ReversionScanResult {
  hits: ReversionHit[];
  regimeByCoin: Record<string, RegimeRead>;
  /** Coverage tally so a dropped coin (stale/thin candles, a fetch throw) is VISIBLE, not
   *  silently indistinguishable from "no setup" — which would make the reversion-extreme
   *  forward-test look more complete than it is. `scanned` = coins that reached the 15m
   *  signal evaluation; `skipped` = requested − scanned. */
  coverage: { requested: number; scanned: number; skipped: number };
}

const HOUR_MS = 3_600_000;

/**
 * Scan `coins` for reversion-extreme setups, each GATED by its 4h regime. Returns
 * the fired hits + the per-coin 4h regime read (the cycle surfaces both). A missing
 * fetcher defaults to the real candle service (lazy import keeps this module's pure
 * imports light and lets tests inject a fake without touching HL).
 */
export async function scanReversionExtremes(
  coins: string[],
  now: number,
  fetchCandles?: ScanCandleFetch,
): Promise<ReversionScanResult> {
  const fc: ScanCandleFetch =
    fetchCandles ?? (async (coin, interval, startMs, endMs) => {
      const { fetchCandles: realFc } = await import('@/lib/hyperliquid/candle-service');
      const res = await realFc(coin, interval, startMs, endMs);
      return { stale: res.stale, candles: res.candles };
    });

  const hits: ReversionHit[] = [];
  const regimeByCoin: Record<string, RegimeRead> = {};
  let scanned = 0;

  for (const coin of coins) {
    try {
      // 4h regime gate. The vendored detector needs currentIndex ≥ 50 ⇒ ≥52 raw bars
      // (drop the in-progress bar first). Below that it returns neutral/0, which would
      // silently UN-gate the fade — so guard the bar count. Its own try: a 4h blip
      // degrades to efficiency-only reversion, never a dropped coin.
      let regimeGate: RegimeGate | undefined;
      try {
        const reg4h = await fc(coin, '4h', now - 45 * 24 * HOUR_MS, now);
        if (!reg4h.stale && reg4h.candles.length >= 52) {
          const completed = reg4h.candles.slice(0, -1);
          const sig = detectMarketRegime(completed, completed.length - 1);
          regimeByCoin[coin] = { regime: sig.regime, confidence: sig.confidence, trend: sig.indicators.trend };
          regimeGate = { regime: sig.regime, confidence: sig.confidence };
        }
      } catch { /* 4h read failed → efficiency-only reversion (never un-gates a trend) */ }

      // 15m reversion, gated by the 4h regime.
      const res = await fc(coin, '15m', now - 30 * HOUR_MS, now);
      if (res.stale || res.candles.length < 120) continue; // too thin/stale → counts as skipped
      const bars = res.candles.slice(0, -1).map((c) => ({ highPx: c.high, lowPx: c.low, closePx: c.close }));
      scanned++; // reached a full signal evaluation for this coin
      const sig = reversionSignal(bars, undefined, regimeGate);
      if (sig) {
        hits.push({
          coin,
          side: sig.side,
          z: sig.zScore,
          er: sig.efficiency,
          regime: sig.regimeLabel,
          regimeConf: sig.regimeConfidence,
          mark: sig.markPx,
          stop: sig.stopPx,
          target: sig.targetPx,
          stopFrac: sig.stopFrac,
        });
      }
    } catch { /* per-coin fail-soft → the coin is left out of `scanned` (counts as skipped) */ }
  }

  return { hits, regimeByCoin, coverage: { requested: coins.length, scanned, skipped: coins.length - scanned } };
}
