/**
 * Scoped agent actions (ADR-0009): the PURE checks.
 *
 * The agent may ask production for two risk-reducing actions on a live position:
 * tighten the protective stop, or close part or all of the position reduce-only.
 * Every rule that makes a request "risk-reducing" lives here, with no I/O.
 */

import { floorHlSize } from '@/lib/hyperliquid/hyperliquid-order-business-logic';

/** Refuse a stop closer than this fraction to the mark: it triggers on noise. */
export const MIN_STOP_DIST_FRAC = 0.005;
/** Refuse a stop further than this fraction from the mark: a likely typing error. */
export const MAX_STOP_DIST_FRAC = 0.5;
/** Hyperliquid rejects an order below this notional. */
export const MIN_ORDER_NOTIONAL_USD = 10;

export type AgentActionRequest =
  | { action: 'tighten-stop'; coin: string; triggerPx: number }
  | { action: 'reduce'; coin: string; fraction: number };

export type ParseResult = { ok: true; request: AgentActionRequest } | { ok: false; error: string };
export type CheckResult = { ok: true } | { ok: false; reason: string };

const COIN_RE = /^[A-Z0-9]{1,16}$/;

/** Strict parse of the request body. Unknown actions and out-of-range values are refused, never clamped. */
export function parseAgentActionRequest(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const coin = typeof b.coin === 'string' ? b.coin.trim().toUpperCase() : '';
  if (!COIN_RE.test(coin)) return { ok: false, error: 'coin is required (letters and digits only)' };
  if (b.action === 'tighten-stop') {
    const px = b.triggerPx;
    if (typeof px !== 'number' || !Number.isFinite(px) || px <= 0) return { ok: false, error: 'triggerPx must be a positive number' };
    return { ok: true, request: { action: 'tighten-stop', coin, triggerPx: px } };
  }
  if (b.action === 'reduce') {
    const f = b.fraction;
    if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0 || f > 1) return { ok: false, error: 'fraction must be a number above 0 and at most 1' };
    return { ok: true, request: { action: 'reduce', coin, fraction: f } };
  }
  return { ok: false, error: "action must be 'tighten-stop' or 'reduce'" };
}

/**
 * A stop move is allowed only when it reduces risk:
 *  - the new stop is on the protective side of the mark (a short's stop above, a long's below);
 *  - the new stop is between MIN and MAX distance from the mark;
 *  - the new stop is strictly tighter than the tightest resting stop, when one rests.
 * With no resting stop the request adds protection, so it is allowed.
 */
export function checkTightenStop(input: { side: 'long' | 'short'; markPx: number; newPx: number; oldPx: number | null }): CheckResult {
  const { side, markPx, newPx, oldPx } = input;
  if (!Number.isFinite(markPx) || markPx <= 0) return { ok: false, reason: 'bad-mark' };
  if (!Number.isFinite(newPx) || newPx <= 0) return { ok: false, reason: 'bad-stop-price' };
  if (side === 'long' ? newPx >= markPx : newPx <= markPx) return { ok: false, reason: 'stop-on-wrong-side-of-mark' };
  const dist = Math.abs(markPx - newPx) / markPx;
  if (dist < MIN_STOP_DIST_FRAC) return { ok: false, reason: 'stop-too-close-to-mark' };
  if (dist > MAX_STOP_DIST_FRAC) return { ok: false, reason: 'stop-too-far-from-mark' };
  if (oldPx != null) {
    if (!Number.isFinite(oldPx) || oldPx <= 0) return { ok: false, reason: 'bad-resting-stop' };
    const tighter = side === 'long' ? newPx > oldPx : newPx < oldPx;
    if (!tighter) return { ok: false, reason: 'not-tighter-than-resting-stop' };
  }
  return { ok: true };
}

/** The tightest of several resting stops: the highest for a long, the lowest for a short. Null when none is usable. */
export function tightestStopPx(side: 'long' | 'short', prices: readonly number[]): number | null {
  const usable = prices.filter((p) => Number.isFinite(p) && p > 0);
  if (usable.length === 0) return null;
  return side === 'long' ? Math.max(...usable) : Math.min(...usable);
}

/** The size that the venue submits for a close of `fraction`: floored to the coin's lot. */
export function flooredCloseSize(sz: number, fraction: number, szDecimals: number): number {
  return floorHlSize(sz * fraction, szDecimals);
}

/**
 * A reduce is allowed only when both the closed part and the part that stays open
 * are tradable: Hyperliquid rejects an order under the minimum notional, and a
 * remainder under it could not be closed later by a normal order. The venue floors
 * the order size to the coin's lot (`szDecimals`), so the check uses the floored size.
 */
export function checkReduce(input: { sz: number; markPx: number; fraction: number; szDecimals: number }): CheckResult {
  const { sz, markPx, fraction, szDecimals } = input;
  if (!Number.isFinite(sz) || sz <= 0) return { ok: false, reason: 'flat' };
  if (!Number.isFinite(markPx) || markPx <= 0) return { ok: false, reason: 'bad-mark' };
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return { ok: false, reason: 'bad-fraction' };
  if (!Number.isInteger(szDecimals) || szDecimals < 0) return { ok: false, reason: 'bad-lot-size' };
  const closeSz = flooredCloseSize(sz, fraction, szDecimals);
  if (closeSz * markPx < MIN_ORDER_NOTIONAL_USD) return { ok: false, reason: 'close-below-min-notional' };
  if (fraction < 1 && (sz - closeSz) * markPx < MIN_ORDER_NOTIONAL_USD) return { ok: false, reason: 'remainder-below-min-notional' };
  return { ok: true };
}
