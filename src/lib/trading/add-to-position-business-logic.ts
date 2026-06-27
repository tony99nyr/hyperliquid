/**
 * PURE math + guards for ADDING to an open position (pyramiding) — fixture-tested.
 *
 * Adding increases SIZE (re-averaging entry); it is NOT a margin/leverage change.
 * The safety story the UI must present:
 *   - new total size, new avg entry, new notional, new $ at-risk (BIGGER);
 *   - new liquidation price (and that the %-buffer stays ~constant at the same
 *     leverage — the real added risk is the larger position, not a closer liq);
 *   - AVERAGING-DOWN flag when the position is underwater (mark worse than avg
 *     entry) — the martingale pattern; adding to a WINNER is the intended use.
 */

import { isolatedLiqPx } from './leverage-business-logic';

export type PositionSideLabel = 'long' | 'short';

/** MMR-aware liquidation price — the canonical isolatedLiqPx (single source of truth,
 *  so the add preview's "new liq" can never drift from the panel's). PURE. */
const liqPriceFor = (side: PositionSideLabel, entryPx: number, leverage: number): number | null =>
  isolatedLiqPx(side, entryPx, leverage);
export type AddSizeMode = 'pct' | 'usd';

/** Hard cap: a single add can be at most this multiple of the current size.
 *  Single source of truth — the route enforces it, the UI preview shows it. */
export const MAX_ADD_MULTIPLE = 5;

export interface AddPreview {
  addSz: number;
  addNotionalUsd: number;
  /** Extra isolated margin the add commits (addNotional / leverage). */
  addMarginUsd: number;
  newSz: number;
  newAvgEntryPx: number;
  newNotionalUsd: number;
  newLiqPx: number | null;
  /** % distance from the live mark to the NEW liquidation (≥0), or null. */
  newLiqDistPct: number | null;
  prevLiqPx: number | null;
  prevLiqDistPct: number | null;
  /** Dollar loss if the (new, larger) position were liquidated ≈ new margin. */
  riskAtLiqUsd: number;
  /** Effective leverage after the add (new notional / new margin). */
  newEffLeverage: number;
  /** True when adding while underwater (mark worse than avg entry) — averaging DOWN. */
  isAveragingDown: boolean;
  warnings: string[];
}

/** Resolve the add size (coins) from the operator's input. PURE. */
export function computeAddSize(currentSz: number, mode: AddSizeMode, value: number, markPx: number): number {
  if (!(currentSz > 0) || !(value > 0) || !(markPx > 0)) return 0;
  if (mode === 'pct') return (currentSz * value) / 100;
  return value / markPx; // 'usd' = notional to add → coins at the mark
}

function distPct(markPx: number, liqPx: number | null): number | null {
  if (liqPx == null || !(markPx > 0) || !Number.isFinite(liqPx)) return null;
  return (Math.abs(markPx - liqPx) / markPx) * 100;
}

/** Build the full add preview. PURE. */
export function previewAdd(input: {
  side: PositionSideLabel;
  currentSz: number;
  currentEntryPx: number;
  markPx: number;
  leverage: number;
  mode: AddSizeMode;
  value: number;
  /** Cap: max add as a multiple of current size (server enforces too). */
  maxAddMultiple?: number;
  /** REAL isolated margin currently backing the position (HL marginUsed). When given,
   *  liq + $-at-risk are computed margin-aware (reflecting margin you've posted) instead
   *  of the leverage-SETTING formula (which ignores it and shows a too-close liq). */
  currentMarginUsd?: number;
}): AddPreview {
  const { side, currentSz, currentEntryPx, markPx, leverage } = input;
  const lev = leverage > 0 ? leverage : 1;
  const warnings: string[] = [];

  const addSz = computeAddSize(currentSz, input.mode, input.value, markPx);
  if (!(addSz > 0)) warnings.push('Add size is zero — check the amount.');
  const cap = input.maxAddMultiple ?? MAX_ADD_MULTIPLE;
  if (currentSz > 0 && addSz > currentSz * cap) {
    warnings.push(`Add exceeds ${cap}× the current position — reduce the amount.`);
  }

  const newSz = currentSz + Math.max(0, addSz);
  // Volume-weighted new entry (the add fills at the live mark).
  const newAvgEntryPx = newSz > 0 ? (currentSz * currentEntryPx + addSz * markPx) / newSz : currentEntryPx;

  const addNotionalUsd = addSz * markPx;
  const addMarginUsd = addNotionalUsd / lev; // HL posts this margin for the added size
  const newNotionalUsd = newSz * markPx;

  // Margin-aware path: when we know the REAL isolated margin, derive liq from the
  // effective leverage (notional / margin) so posted margin pushes liq away — the
  // accurate picture. Without it, fall back to the leverage-SETTING formula (which
  // ignores posted margin and shows a too-close liq). Effective-leverage liq matches
  // HL's isolated liq within ~1%.
  const curMargin = input.currentMarginUsd;
  const marginAware = curMargin != null && curMargin > 0;
  const newMarginUsd = marginAware ? curMargin + addMarginUsd : newNotionalUsd / lev;
  const prevEffLev = marginAware && curMargin > 0 ? (currentSz * markPx) / curMargin : lev;
  const newEffLeverage = newMarginUsd > 0 ? newNotionalUsd / newMarginUsd : lev;

  const prevLiqPx = liqPriceFor(side, currentEntryPx, marginAware ? prevEffLev : lev);
  const newLiqPx = liqPriceFor(side, newAvgEntryPx, marginAware ? newEffLeverage : lev);
  const newLiqDistPct = distPct(markPx, newLiqPx);

  // Averaging DOWN = adding while the position is in a loss (mark worse than entry).
  const isAveragingDown = side === 'long' ? markPx < currentEntryPx : markPx > currentEntryPx;

  // Dollar at risk to a liquidation ≈ the new isolated margin (isolated caps loss to
  // the posted margin) — the number that GREW. Margin-aware: the real new margin.
  const riskAtLiqUsd = newMarginUsd;

  return {
    addSz: round(addSz, 6),
    addNotionalUsd: round(addNotionalUsd, 2),
    addMarginUsd: round(addMarginUsd, 2),
    newSz: round(newSz, 6),
    newAvgEntryPx: round(newAvgEntryPx, 6),
    newNotionalUsd: round(newNotionalUsd, 2),
    newLiqPx,
    newLiqDistPct,
    newEffLeverage: round(newEffLeverage, 2),
    prevLiqPx,
    prevLiqDistPct: distPct(markPx, prevLiqPx),
    riskAtLiqUsd: round(riskAtLiqUsd, 2),
    isAveragingDown,
    warnings,
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
