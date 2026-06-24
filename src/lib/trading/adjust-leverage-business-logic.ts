/**
 * PURE leverage-adjust logic — change the leverage on an ALREADY-OPEN isolated
 * position. Changing leverage on an open isolated position does NOT change the
 * position size; it adjusts the posted isolated margin, which MOVES the
 * liquidation price (raising leverage releases margin → liq moves toward mark;
 * lowering leverage posts more margin → liq moves away). This computes the
 * validated leverage, the new liquidation price, and a SELF-CONTAINED danger
 * guard for that move. No I/O — the route feeds it the live position + request.
 *
 * SAFETY: an open position has no persisted stop, so the entry-flow
 * "liquidation-inside-stop" guard can't apply. Instead the guard here is
 * mark-relative: raising leverage that pushes the new liquidation price within
 * ADJUST_LIQ_DANGER_PCT of the CURRENT MARK is flagged (you'd be one small
 * adverse move from liquidation). The route requires an explicit ack to proceed.
 */

import { clampLeverage, liquidationPx } from './leverage-business-logic';

/** New liquidation within this % of the current mark ⇒ danger (ack required). */
export const ADJUST_LIQ_DANGER_PCT = 5;

/** A directional open position. ('flat' has no leverage to adjust.) */
export type OpenPositionSide = 'long' | 'short';

export interface AdjustLeverageInput {
  side: OpenPositionSide;
  entryPx: number;
  /** Current mark price; null when unknown (no live mark → no danger assertion). */
  markPx: number | null;
  /** Leverage currently recorded on the position (null when never persisted). */
  currentLeverage: number | null;
  /** Operator's requested leverage (pre-validation). */
  requestedLeverage: number;
  /** The coin's max leverage (slider ceiling / server cap). */
  coinMax: number;
}

export interface AdjustLeveragePlan {
  /** Requested leverage validated into [1, coinMax]. */
  leverage: number;
  /** True when the validated leverage differs from the current (integer-compared). */
  changed: boolean;
  /** New estimated liquidation price at the validated leverage. */
  liqPx: number | null;
  /** Current liquidation price at the existing leverage (for before/after display). */
  currentLiqPx: number | null;
  /** |new liq − mark| / mark × 100, or null when mark/liq unknown. */
  liqDistFromMarkPct: number | null;
  /** New liq sits within ADJUST_LIQ_DANGER_PCT of the mark ⇒ ack required. */
  dangerNearMark: boolean;
  /** Raising leverage (validated > current) — the direction that moves liq toward mark. */
  isRaise: boolean;
}

const toOrderSide = (side: OpenPositionSide): 'buy' | 'sell' => (side === 'short' ? 'sell' : 'buy');

/**
 * Compute the adjust-leverage plan. Pure + deterministic. The danger flag is only
 * raised on a RAISE (lowering leverage always moves liq AWAY from mark — safer —
 * so it never needs an ack), and only when a mark price is known.
 */
export function adjustLeveragePlan(input: AdjustLeverageInput): AdjustLeveragePlan {
  const leverage = clampLeverage(input.requestedLeverage, input.coinMax);
  const order = toOrderSide(input.side);

  const liqPx = input.entryPx > 0 ? liquidationPx(order, input.entryPx, leverage) : null;
  const currentLiqPx =
    input.entryPx > 0 && input.currentLeverage != null && input.currentLeverage >= 1
      ? liquidationPx(order, input.entryPx, input.currentLeverage)
      : null;

  // "changed" compares on the integer leverage HL actually applies (it rounds).
  const curRounded = input.currentLeverage != null ? Math.round(input.currentLeverage) : null;
  const changed = curRounded === null ? true : Math.round(leverage) !== curRounded;
  const isRaise = curRounded === null ? false : Math.round(leverage) > curRounded;

  let liqDistFromMarkPct: number | null = null;
  if (liqPx != null && input.markPx != null && input.markPx > 0) {
    liqDistFromMarkPct = (Math.abs(liqPx - input.markPx) / input.markPx) * 100;
  }

  // Danger ONLY on a raise that pushes liq inside the band of the live mark.
  // Lowering leverage can never trip this (liq moves away from mark).
  const dangerNearMark =
    isRaise && liqDistFromMarkPct != null && liqDistFromMarkPct <= ADJUST_LIQ_DANGER_PCT;

  return { leverage, changed, liqPx, currentLiqPx, liqDistFromMarkPct, dangerNearMark, isRaise };
}
