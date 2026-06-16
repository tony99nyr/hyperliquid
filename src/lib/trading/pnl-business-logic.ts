/**
 * Position + P&L math (PURE). The heart of the mode-agnosticism guarantee.
 *
 * Every function here folds CanonicalFills into a Position with NO reference to
 * `fill.source`. Identical fills produce identical positions and P&L whether
 * they came from the paper book-match or a live HL confirmation. See ADR-0001.
 *
 * No I/O, no env reads, no clock — fully deterministic and fixture-testable.
 */

import type { CanonicalFill } from '@/types/fill';
import type { Position } from '@/types/position';

/** A flat (empty) position for a coin. */
export function emptyPosition(coin: string): Position {
  return {
    coin,
    side: 'flat',
    sz: 0,
    avgEntryPx: 0,
    realizedPnlUsd: 0,
    feesPaidUsd: 0,
  };
}

/** Signed size: + for long, − for short, 0 for flat. */
function signedSize(pos: Position): number {
  if (pos.side === 'long') return pos.sz;
  if (pos.side === 'short') return -pos.sz;
  return 0;
}

function sideFromSigned(signed: number): Position['side'] {
  if (signed > 0) return 'long';
  if (signed < 0) return 'short';
  return 'flat';
}

/**
 * Effective fill size after reduce-only enforcement. A reduce-only order may only
 * shrink/close the open position in the opposing direction — it can never open or
 * flip. Returns the size clamped to the open exposure (0 when the fill is on the
 * same side as the position, or the position is flat). Non-reduce-only fills pass
 * through unchanged. PURE.
 */
function clampReduceOnlySize(fill: CanonicalFill, beforeSigned: number): number {
  if (!fill.reduceOnly) return fill.sz;
  const fillSign = fill.side === 'buy' ? 1 : -1;
  // A reduce-only fill must oppose the open position (buy reduces a short, sell
  // reduces a long). Same-side or flat ⇒ it would open/grow ⇒ close nothing.
  if (beforeSigned === 0 || Math.sign(beforeSigned) === fillSign) return 0;
  return Math.min(fill.sz, Math.abs(beforeSigned));
}

/**
 * Apply a single fill to a position, returning a NEW position (immutable).
 *
 * Rules:
 * - Increasing exposure (same direction, or opening from flat): blend avg entry.
 * - Reducing/closing: realize P&L on the closed portion at the fill price; avg
 *   entry of the remaining same-direction size is unchanged.
 * - Flipping (close past zero): realize P&L on the closed portion, then open the
 *   remainder on the other side at the fill price.
 * - Fees always accumulate into feesPaidUsd (and reduce net realized via the
 *   caller's reporting; here we track gross realized + fees separately).
 */
export function applyFill(pos: Position, fill: CanonicalFill): Position {
  if (fill.coin !== pos.coin) {
    throw new Error(
      `applyFill: fill coin "${fill.coin}" does not match position coin "${pos.coin}"`,
    );
  }
  // Defense-in-depth: reject non-finite price/size before the money math (live
  // fills come from external JSON; a NaN would silently poison avg entry + P&L).
  if (!Number.isFinite(fill.px) || !Number.isFinite(fill.sz)) {
    throw new Error(`applyFill: non-finite fill px/sz (px=${fill.px}, sz=${fill.sz})`);
  }
  if (fill.sz <= 0) {
    // No size moved (e.g. a fully-unfilled paper order) — only fees, if any.
    return { ...pos, feesPaidUsd: pos.feesPaidUsd + fill.feeUsd };
  }

  const beforeSigned = signedSize(pos);
  // Enforce reduce-only in the PURE fold so paper matches live: HL rejects the
  // overshoot of a reduce-only order server-side, so a reduce-only fill must
  // only ever shrink/close — never open or flip. Clamp the effective size to the
  // open exposure in the closing direction. Keeps the seam invariant (ADR-0001):
  // paper and live fold to the same position even on a mis-sized reduce-only.
  const effectiveSz = clampReduceOnlySize(fill, beforeSigned);
  if (effectiveSz <= 0) {
    // Reduce-only against a flat/aligned position closes nothing — fees only.
    return { ...pos, feesPaidUsd: pos.feesPaidUsd + fill.feeUsd };
  }
  const delta = fill.side === 'buy' ? effectiveSz : -effectiveSz;
  const afterSigned = beforeSigned + delta;

  const feesPaidUsd = pos.feesPaidUsd + fill.feeUsd;
  let realizedPnlUsd = pos.realizedPnlUsd;
  let avgEntryPx = pos.avgEntryPx;

  const sameDirection = beforeSigned === 0 || Math.sign(delta) === Math.sign(beforeSigned);

  if (sameDirection) {
    // Increasing exposure: volume-weighted blend of entry price.
    const beforeAbs = Math.abs(beforeSigned);
    const addAbs = effectiveSz;
    const newAbs = beforeAbs + addAbs;
    avgEntryPx = (avgEntryPx * beforeAbs + fill.px * addAbs) / newAbs;
  } else {
    // Reducing / closing / flipping.
    const closingAbs = Math.min(Math.abs(beforeSigned), effectiveSz);
    // Long closed by a sell earns (exit − entry); short closed by a buy earns
    // (entry − exit). beforeSigned sign encodes the direction.
    const direction = Math.sign(beforeSigned); // +1 long, -1 short
    realizedPnlUsd += direction * (fill.px - pos.avgEntryPx) * closingAbs;

    if (Math.sign(afterSigned) === Math.sign(beforeSigned) || afterSigned === 0) {
      // Reduced or fully closed: surviving size keeps the old avg entry.
      avgEntryPx = afterSigned === 0 ? 0 : pos.avgEntryPx;
    } else {
      // Flipped past zero: the overshoot opens a fresh position at the fill px.
      avgEntryPx = fill.px;
    }
  }

  return {
    coin: pos.coin,
    side: sideFromSigned(afterSigned),
    sz: Math.abs(afterSigned),
    avgEntryPx,
    realizedPnlUsd,
    feesPaidUsd,
  };
}

/** Apply a sequence of fills in order. */
export function applyFills(coin: string, fills: CanonicalFill[]): Position {
  return fills.reduce((pos, f) => applyFill(pos, f), emptyPosition(coin));
}

/**
 * Mark-to-market unrealized P&L (USD) for the open size at a mark price.
 * Long gains when mark > entry; short gains when mark < entry. Flat ⇒ 0.
 */
export function unrealizedPnl(pos: Position, markPx: number): number {
  if (pos.side === 'flat' || pos.sz === 0) return 0;
  const direction = pos.side === 'long' ? 1 : -1;
  return direction * (markPx - pos.avgEntryPx) * pos.sz;
}

/** Volume-weighted average entry of the currently open size (0 when flat). */
export function avgEntry(pos: Position): number {
  return pos.side === 'flat' ? 0 : pos.avgEntryPx;
}

/**
 * Total P&L = realized + unrealized − fees. Net of fees so the cockpit shows an
 * honest number (matters for the paper trial scoring).
 */
export function totalPnl(pos: Position, markPx: number): number {
  return pos.realizedPnlUsd + unrealizedPnl(pos, markPx) - pos.feesPaidUsd;
}
