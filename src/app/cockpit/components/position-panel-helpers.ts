/**
 * PURE helpers for the PositionPanel. Normalize the user's folded position (+
 * latest pnl snapshot) and a leader's HL position into a single display shape so
 * the panel can render both columns identically. No I/O, no React.
 */

import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import { unrealizedPnl } from '@/lib/trading/pnl-business-logic';
import type { PnlSnapshot, PositionRow } from '@/hooks/realtime-row-mappers';

/** A unified row the PositionPanel renders for either party. */
export interface PositionDisplay {
  coin: string;
  side: 'long' | 'short';
  /** Absolute size in coin units. */
  sz: number;
  entryPx: number | null;
  markPx: number | null;
  unrealizedPnlUsd: number | null;
  liqPx: number | null;
  leverage: number | null;
}

/**
 * Build the user's display row from the folded position + the latest pnl
 * snapshot (mark price). Unrealized P&L prefers the snapshot's stored value;
 * if absent but a mark exists, it is recomputed via the PURE pnl math.
 */
export function userPositionDisplay(
  pos: PositionRow,
  pnl: PnlSnapshot | undefined,
): PositionDisplay {
  const side = pos.side === 'short' ? 'short' : 'long';
  const markPx = pnl?.markPx ?? null;
  let uPnl: number | null = pnl ? pnl.unrealizedPnlUsd : null;
  if ((uPnl === null || uPnl === 0) && markPx !== null) {
    uPnl = unrealizedPnl(
      { coin: pos.coin, side: pos.side, sz: pos.sz, avgEntryPx: pos.avgEntryPx, realizedPnlUsd: 0, feesPaidUsd: 0 },
      markPx,
    );
  }
  return {
    coin: pos.coin,
    side,
    sz: pos.sz,
    entryPx: pos.avgEntryPx || null,
    markPx,
    unrealizedPnlUsd: uPnl,
    liqPx: null, // paper/live position rows don't carry a liq price
    leverage: pos.leverage,
  };
}

/** A dense display shape for the bottom Active-Position bar. */
export interface ActivePositionStats {
  coin: string;
  side: 'long' | 'short';
  sz: number;
  entryPx: number | null;
  markPx: number | null;
  /** |sz| * markPx (or entry when no mark) in USD. */
  notionalUsd: number | null;
  unrealizedPnlUsd: number | null;
  /** P&L as a percent of entry notional (sign carries direction). */
  pnlPct: number | null;
  /** Position leverage (e.g. 5 = 5x), or null when unknown. */
  leverage: number | null;
  /**
   * Return on equity = unrealizedPnl / margin, where margin = entryNotional /
   * leverage. The leverage-adjusted P&L a perp trader watches. Null when
   * leverage or P&L is unknown.
   */
  roePct: number | null;
  feesPaidUsd: number;
  /** ms since the position last changed (entry/add). */
  timeInTradeMs: number | null;
}

/**
 * Build the dense bottom-bar stats for the user's open position. PURE — `now` is
 * injected so the time-in-trade is testable. pnlPct is computed off entry
 * notional so it reads as a clean percent move regardless of size.
 */
export function activePositionStats(
  pos: PositionRow,
  pnl: PnlSnapshot | undefined,
  now: number,
): ActivePositionStats {
  const d = userPositionDisplay(pos, pnl);
  const refPx = d.markPx ?? d.entryPx;
  const notionalUsd = refPx !== null ? Math.abs(d.sz) * refPx : null;
  const entryNotional = d.entryPx !== null ? Math.abs(d.sz) * d.entryPx : null;
  const pnlPct =
    d.unrealizedPnlUsd !== null && entryNotional && entryNotional > 0
      ? (d.unrealizedPnlUsd / entryNotional) * 100
      : null;
  // ROE = uPnl / margin, margin = entryNotional / leverage. Equivalent to
  // pnlPct * leverage — the leverage-magnified return on the posted margin.
  const roePct =
    pnlPct !== null && d.leverage !== null && d.leverage > 0
      ? pnlPct * d.leverage
      : null;
  return {
    coin: d.coin,
    side: d.side,
    sz: d.sz,
    entryPx: d.entryPx,
    markPx: d.markPx,
    notionalUsd,
    unrealizedPnlUsd: d.unrealizedPnlUsd,
    pnlPct,
    leverage: d.leverage,
    roePct,
    feesPaidUsd: pos.feesPaidUsd,
    timeInTradeMs: pos.updatedAt > 0 ? Math.max(0, now - pos.updatedAt) : null,
  };
}

/** Build a leader's display row from an HL clearinghouse position. */
export function leaderPositionDisplay(p: HlPosition): PositionDisplay {
  const markPx =
    p.entryPx !== null && p.size > 0 ? p.entryPx + p.unrealizedPnl / (p.szi || 1) : null;
  return {
    coin: p.coin,
    side: p.side,
    sz: p.size,
    entryPx: p.entryPx,
    markPx: Number.isFinite(markPx ?? NaN) ? markPx : null,
    unrealizedPnlUsd: p.unrealizedPnl,
    liqPx: p.liquidationPx,
    leverage: p.leverage,
  };
}
