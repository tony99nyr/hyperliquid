import type { PriceCandle } from '@/types/trading-core';
import { INTERVAL_MS, type CandleInterval } from '@/lib/hyperliquid/candle-service-business-logic';
import { htfTrendExitHit } from './htf-trend-signal-business-logic';
import { compressionExitHit } from './compression-squeeze-signal-business-logic';

export interface BlackoutGhost {
  lane: string;
  coin: string;
  side: 'long' | 'short';
  entryPx: number;
  stopPx: number;
  riskUsd: number;
  createdAtMs: number;
  exitHorizonMs: number;
}

export type GhostResolution =
  | { status: 'pending'; reason: 'horizon-not-reached' | 'insufficient-candles' }
  | { status: 'resolved'; exitPx: number; exitAtMs: number; r: number; pnlUsd: number; reason: 'stop-hit' | 'lane-exit' | 'horizon' };

/** Resolve a ghost against completed candles. Callers select the lane interval. */
export function resolveBlackoutGhost(
  ghost: BlackoutGhost,
  candles: PriceCandle[],
  interval: CandleInterval,
  nowMs: number,
): GhostResolution {
  const ordered = candles
    .filter((c) => c.timestamp + INTERVAL_MS[interval] <= Math.min(ghost.exitHorizonMs, nowMs))
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  const postEntry = ordered.filter((c) => c.timestamp >= ghost.createdAtMs);
  if (postEntry.length === 0) {
    return { status: 'pending', reason: nowMs < ghost.exitHorizonMs ? 'horizon-not-reached' : 'insufficient-candles' };
  }
  for (let i = 0; i < ordered.length; i += 1) {
    const candle = ordered[i];
    if (candle.timestamp < ghost.createdAtMs) continue;
    const stop = ghost.side === 'long' ? candle.low <= ghost.stopPx : candle.high >= ghost.stopPx;
    if (stop) return finish(ghost, ghost.stopPx, candle.timestamp + INTERVAL_MS[interval], 'stop-hit');
    if (ghost.lane === 'htf-trend' && interval === '1d' && i >= 10) {
      const prior = ordered.slice(i - 10, i);
      const read = {
        latestClose: ordered[i].close,
        don10High: Math.max(...prior.map((c) => c.high)),
        don10Low: Math.min(...prior.map((c) => c.low)),
        don20High: 0, don20Low: 0, atr: 0, breakout: null,
      };
      if (htfTrendExitHit(read, ghost.side)) {
        return finish(ghost, candle.close, candle.timestamp + INTERVAL_MS[interval], 'lane-exit');
      }
    }
    if (ghost.lane === 'compression-straddle' && interval === '4h' && i >= 19) {
      const closes = ordered.slice(i - 19, i + 1).map((c) => c.close);
      const read = {
        latestClose: ordered[i].close,
        bbMid: closes.reduce((sum, close) => sum + close, 0) / closes.length,
        bbw: 0,
        bbwPctile: 0,
        inSqueeze: false,
        barsSinceSqueeze: null,
        don20High: 0,
        don20Low: 0,
        breakout: null,
      };
      if (compressionExitHit(read, ghost.side)) {
        return finish(ghost, candle.close, candle.timestamp + INTERVAL_MS[interval], 'lane-exit');
      }
    }
  }
  const last = postEntry[postEntry.length - 1];
  if (nowMs < ghost.exitHorizonMs) {
    return { status: 'pending', reason: 'horizon-not-reached' };
  }
  return finish(ghost, last.close, ghost.exitHorizonMs, 'horizon');
}

function finish(ghost: BlackoutGhost, exitPx: number, exitAtMs: number, reason: 'stop-hit' | 'lane-exit' | 'horizon'): GhostResolution {
  const signedMove = ghost.side === 'long' ? exitPx - ghost.entryPx : ghost.entryPx - exitPx;
  const r = signedMove / Math.abs(ghost.entryPx - ghost.stopPx);
  return { status: 'resolved', exitPx, exitAtMs, r, pnlUsd: r * ghost.riskUsd, reason };
}
