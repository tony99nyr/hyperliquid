/**
 * Position state — the running result of applying canonical fills.
 *
 * Mode-unaware by construction: a Position is the fold of CanonicalFills and
 * carries no `source` discriminator. Identical fills (paper or live) fold to an
 * identical Position. See ADR-0001 and pnl-business-logic.ts.
 */

export type PositionSide = 'long' | 'short' | 'flat';

export interface Position {
  coin: string;
  /** long / short / flat. flat ⇒ sz === 0. */
  side: PositionSide;
  /** Net size in coin units (always >= 0; direction is in `side`). */
  sz: number;
  /** Volume-weighted average entry price of the open size. 0 when flat. */
  avgEntryPx: number;
  /** Realized P&L (USD) accumulated from closing fills. */
  realizedPnlUsd: number;
  /** Total fees paid (USD) across all fills applied to this position. */
  feesPaidUsd: number;
}
