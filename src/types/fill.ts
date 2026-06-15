/**
 * The canonical fill record — the crux of the seamless paper ↔ live design.
 *
 * BOTH the paper source (order-book match) and the live source (HL exchange
 * confirmation) produce this exact shape. Downstream code (position tracker,
 * P&L) consumes ONLY this and CANNOT tell paper from live. `source` is recorded
 * for audit but MUST NEVER be branched on downstream. See ADR-0001.
 */

export type TradingMode = 'paper' | 'live';

export type OrderSide = 'buy' | 'sell';

/**
 * A trade intent — what the human confirms. Mode-agnostic: the same intent can
 * be executed paper or live; only the fill source differs.
 */
export interface TradeIntent {
  /** Idempotency key, generated client-side, identical across modes + retries. */
  clientIntentId: string;
  /** Session this intent belongs to (cockpit session row id). */
  sessionId: string;
  coin: string;
  side: OrderSide;
  /** Order size in coin units (always positive). */
  sz: number;
  /**
   * Limit price. For a market order leave undefined (the book walk fills at
   * whatever the book offers). For a limit order the match must not cross it.
   */
  limitPx?: number;
  /** Reduce-only orders can only shrink/close an existing position. */
  reduceOnly: boolean;
  /** Epoch ms the intent was created. */
  createdAt: number;
}

/**
 * The canonical fill. Identical fields regardless of source — that identity is
 * what the mode-agnosticism test pins down.
 */
export interface CanonicalFill {
  /** Same id as the originating intent (idempotency, both modes). */
  clientIntentId: string;
  sessionId: string;
  coin: string;
  side: OrderSide;
  /** Volume-weighted average fill price. */
  px: number;
  /** Filled size in coin units (<= intent.sz for partial fills). */
  sz: number;
  /** px * sz, in USD. */
  notionalUsd: number;
  /** Fee paid in USD (modeled from HL's schedule for paper; actual for live). */
  feeUsd: number;
  reduceOnly: boolean;
  /** True when the book could not fully fill the requested size. */
  partial: boolean;
  /** Recorded for audit ONLY — never branched on downstream. */
  source: TradingMode;
  /** HL order id — live only; null in paper. */
  hlOrderId: string | null;
  /** Raw HL confirmation payload — live only; null in paper. */
  hlRaw: Record<string, unknown> | null;
  /** Epoch ms the fill was produced. */
  filledAt: number;
}
