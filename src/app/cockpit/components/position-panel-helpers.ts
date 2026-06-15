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
    leverage: null,
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
