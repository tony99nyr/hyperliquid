/**
 * PURE leverage math for the approval card (no React, no I/O — fixture-tested).
 *
 * Leverage is the OPERATOR's risk decision (Item 3). Notional stays RISK-sized by
 * the proposal (size = riskUsd / stopDistance); leverage governs ONLY the posted
 * margin, the liquidation price, and the leverage-magnified return (ROE). These
 * helpers compute that derived read live as the operator drags the slider, plus
 * the SAFETY GUARD that warns when the liquidation price falls inside the stop
 * (so a high-leverage position would liquidate BEFORE the stop ever triggers).
 *
 * Keeping this pure means the safety invariant — "liquidation before stop ⇒
 * warn + reduce leverage" — is unit-tested independent of the DOM.
 */

import type { OrderSideLabel } from '@/types/cockpit';

/** Inputs to derive the leverage read for a proposed entry. */
export interface LeverageReadInput {
  /** buy = long, sell = short. */
  side: OrderSideLabel;
  /** Risk-sized entry/estimated fill price (USD). */
  entryPx: number;
  /** Risk-sized position size in coin units (always positive). */
  sz: number;
  /** Operator-chosen leverage (e.g. 5 = 5x). */
  leverage: number;
  /** Protective stop price (USD), when the proposal carries one. */
  stopPx?: number | null;
}

/** The derived, leverage-dependent read shown beside the slider. */
export interface LeverageRead {
  /** Position notional at entry = sz * entryPx (leverage-independent). */
  notionalUsd: number;
  /** Posted margin = notional / leverage. */
  marginUsd: number;
  /**
   * Estimated liquidation price (isolated, fee/funding-agnostic). A long
   * liquidates BELOW entry, a short ABOVE, by ~entry/leverage. Null when leverage
   * or entry is non-positive.
   */
  liqPx: number | null;
  /** ROE at the stop (signed; a long stop is a loss). Null when no stop. */
  roeAtStopPct: number | null;
  /** ROE at a hypothetical target. Null when no target supplied. */
  roeAtTargetPct: number | null;
}

/** Clamp leverage to the legal [1, max] band. PURE; used by UI + server. */
export function clampLeverage(leverage: number, coinMax: number): number {
  const max = Number.isFinite(coinMax) && coinMax >= 1 ? coinMax : 1;
  if (!Number.isFinite(leverage) || leverage < 1) return 1;
  if (leverage > max) return max;
  return leverage;
}

/**
 * Validate + coerce a leverage to the legal band for SERVER use (do not trust the
 * client). Returns the clamped integer-or-fractional leverage; a non-finite /
 * non-positive input defaults to `fallback` (the proposal leverage), then clamps.
 */
export function serverValidateLeverage(
  raw: unknown,
  coinMax: number,
  fallback: number,
): number {
  const fb = Number.isFinite(fallback) && fallback >= 1 ? fallback : 1;
  if (raw === null || raw === undefined) return clampLeverage(fb, coinMax);
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return clampLeverage(fb, coinMax);
  return clampLeverage(n, coinMax);
}

/** HL maintenance-margin rate — the single source of truth for liq math that wants
 *  to account for the maintenance buffer (liquidates slightly sooner than margin-only). */
export const MMR = 0.004;

/**
 * Canonical isolated-margin liquidation price (PURE). A long liquidates BELOW entry
 * by ~entry/leverage, a short ABOVE. `mmr` (maintenance rate) pulls liq slightly
 * toward the mark — pass the default for the HL-accurate estimate, or 0 for the
 * first-order margin-only estimate. Returns null for degenerate inputs.
 *
 * This is THE liq formula — `liquidationPx` (buy/sell, margin-only) and the cockpit's
 * `liquidationPrice` / `liqPriceFor` (long/short, mmr-aware) all delegate here so the
 * money math lives in one place.
 */
export function isolatedLiqPx(side: 'long' | 'short', entryPx: number, leverage: number, mmr: number = MMR): number | null {
  if (!(entryPx > 0) || !(leverage > 0)) return null;
  return side === 'long' ? entryPx * (1 - 1 / leverage + mmr) : entryPx * (1 + 1 / leverage - mmr);
}

/** Margin-only (no maintenance buffer) liquidation price, side as buy/sell. Delegates
 *  to {@link isolatedLiqPx} with mmr=0. Keeps the `leverage >= 1` guard of its callers. */
export function liquidationPx(side: OrderSideLabel, entryPx: number, leverage: number): number | null {
  if (!(leverage >= 1)) return null;
  return isolatedLiqPx(side === 'buy' ? 'long' : 'short', entryPx, leverage, 0);
}

/**
 * A position is "over-margined" when posted margin pulls effective leverage well
 * below the leverage SETTING (≥10% lower) — i.e. you've added margin, so the
 * setting-based liq formula understates how far liquidation really sits. PURE.
 */
export function isOverMargined(effLeverage: number | null | undefined, settingLeverage: number | null | undefined): boolean {
  return effLeverage != null && settingLeverage != null && settingLeverage > 0 && effLeverage < settingLeverage * 0.9;
}

/**
 * ROE at a given exit price = (priceMove / entry) * leverage, signed for the
 * side. ROE is the return on the POSTED MARGIN (leverage-magnified), the number a
 * perp trader actually watches. Returns null for degenerate inputs.
 */
export function roeAtPx(
  side: OrderSideLabel,
  entryPx: number,
  exitPx: number,
  leverage: number,
): number | null {
  if (!(entryPx > 0) || !(leverage >= 1) || !Number.isFinite(exitPx)) return null;
  const moveFrac = (exitPx - entryPx) / entryPx; // +ve = price rose
  const dirMoveFrac = side === 'buy' ? moveFrac : -moveFrac; // gain in the trade's favor
  return dirMoveFrac * leverage * 100;
}

/** Build the full leverage read (margin / liq / ROE-at-stop / ROE-at-target). */
export function deriveLeverageRead(
  input: LeverageReadInput & { targetPx?: number | null },
): LeverageRead {
  const lev = input.leverage >= 1 ? input.leverage : 1;
  const notionalUsd = input.sz > 0 && input.entryPx > 0 ? input.sz * input.entryPx : 0;
  const marginUsd = lev > 0 ? notionalUsd / lev : 0;
  return {
    notionalUsd,
    marginUsd,
    liqPx: liquidationPx(input.side, input.entryPx, lev),
    roeAtStopPct:
      input.stopPx != null ? roeAtPx(input.side, input.entryPx, input.stopPx, lev) : null,
    roeAtTargetPct:
      input.targetPx != null ? roeAtPx(input.side, input.entryPx, input.targetPx, lev) : null,
  };
}

/**
 * THE SAFETY GUARD. True when the estimated liquidation price falls AT or INSIDE
 * the protective stop — i.e. the position would liquidate BEFORE the stop could
 * trigger, defeating the risk plan (classic high-leverage trap: a 5% stop at 20x
 * liquidates at ~5%). "Inside" is direction-aware:
 *   - long  (stop below entry): liq >= stop  ⇒ liq is at/above the stop ⇒ DANGER.
 *   - short (stop above entry): liq <= stop  ⇒ liq is at/below the stop ⇒ DANGER.
 * Returns false when either price is unknown (cannot assert danger).
 */
export function liquidationInsideStop(
  side: OrderSideLabel,
  liqPx: number | null,
  stopPx: number | null | undefined,
): boolean {
  if (liqPx == null || stopPx == null || !Number.isFinite(liqPx) || !Number.isFinite(stopPx)) {
    return false;
  }
  return side === 'buy' ? liqPx >= stopPx : liqPx <= stopPx;
}

/**
 * Pick a coin's max leverage for the slider ceiling. Prefer the leader's reported
 * maxLeverage on that coin (most authoritative — it's the exchange's real cap);
 * else a conservative per-coin default; else a global floor. The UI never lets the
 * slider exceed this, and the SERVER re-clamps independently (don't trust client).
 */
export function resolveCoinMaxLeverage(
  coin: string,
  leaderMaxLeverage?: number | null,
): number {
  if (leaderMaxLeverage != null && Number.isFinite(leaderMaxLeverage) && leaderMaxLeverage >= 1) {
    return Math.floor(leaderMaxLeverage);
  }
  // Conservative HL-style per-coin defaults when no leader cap is known. These
  // are the slider CEILING only — the leader's real reported cap (above) always
  // wins. HYPE's exchange max is 40x, but we cap our default at 5x: it's a newer,
  // more volatile token and this is a manual-copy cockpit, so we keep the
  // fallback conservative until a leader cap is observed.
  const norm = coin.trim().toUpperCase();
  // Conservative ceilings for the majors added 2026-06 (real HL caps are higher;
  // these are deliberately low for a manual-copy cockpit — a leader's observed cap
  // overrides, and the server re-clamps).
  const DEFAULTS: Record<string, number> = { BTC: 40, ETH: 25, SOL: 20, HYPE: 5, XRP: 20, DOGE: 10, SUI: 10, AVAX: 10, LINK: 10 };
  return DEFAULTS[norm] ?? 10;
}

/** Half-leader preset (rounded down, floored at 1×). */
export function halfLeaderLeverage(leaderLeverage: number | null | undefined): number | null {
  if (leaderLeverage == null || !Number.isFinite(leaderLeverage) || leaderLeverage < 1) return null;
  return Math.max(1, Math.floor(leaderLeverage / 2));
}
