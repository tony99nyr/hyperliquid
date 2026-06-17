/**
 * PURE helpers for the Open Positions focal panel (design handoff). No React, no
 * I/O — fixture-tested. Maps a folded position + its live mark + the asset's
 * regime into the panel's per-position health block:
 *
 *   - alignment vs regime  (ALIGNED ✓ when the side agrees with the regime
 *     direction, FIGHTING ⚠ when it opposes; neutral regime ⇒ aligned/neutral)
 *   - liquidation price + distance (% away from mark)
 *   - the liq-distance bar (green > 14%, amber 6–14%, red < 6%)
 *   - per-position uPnL + uPnL%
 *
 * The liquidation math mirrors the design + venue formulas:
 *   liq(long)  = entry × (1 − 1/lev + mmr)
 *   liq(short) = entry × (1 + 1/lev − mmr),  mmr ≈ 0.004
 *
 * NOTE: live HL positions carry an exchange-supplied `liquidationPx`; when
 * present that is authoritative and used instead of the formula.
 */

import { ZONE_COLORS } from './panel-styles';

export type RegimeDir = 'bullish' | 'bearish' | 'neutral';

export interface PositionHealth {
  /** True when the position side agrees with the regime (or regime neutral). */
  aligned: boolean;
  /** "ALIGNED ✓" or "FIGHTING ⚠". */
  alignLabel: string;
  /** Color for the alignment chip (green aligned / amber fighting). */
  alignColor: string;
  /** Liquidation price, or null when it can't be computed. */
  liqPx: number | null;
  /** Percent distance from the live mark to liquidation (always ≥ 0). */
  liqDistPct: number | null;
  /** Liq-distance bar fill width as a CSS percent string. */
  liqBarWidth: string;
  /** Color for the liq distance + bar (green/amber/red by proximity). */
  liqColor: string;
}

const MMR = 0.004;

/** Maintenance-margin liquidation price for a leveraged perp. PURE. */
export function liquidationPrice(
  side: 'long' | 'short',
  entryPx: number,
  leverage: number,
): number | null {
  if (!Number.isFinite(entryPx) || entryPx <= 0 || !Number.isFinite(leverage) || leverage <= 0) {
    return null;
  }
  return side === 'long'
    ? entryPx * (1 - 1 / leverage + MMR)
    : entryPx * (1 + 1 / leverage - MMR);
}

/** Color for a liquidation proximity: green > 14%, amber 6–14%, red < 6%. */
export function liqColorFor(distPct: number | null): string {
  if (distPct === null) return ZONE_COLORS.warn;
  if (distPct < 6) return ZONE_COLORS.danger;
  if (distPct < 14) return ZONE_COLORS.warn;
  return ZONE_COLORS.ok;
}

/** Liq-distance bar fill: closer to liquidation ⇒ fuller bar (design formula). */
export function liqBarWidth(distPct: number | null): string {
  if (distPct === null) return '0%';
  return `${Math.max(6, Math.min(100, 100 - distPct * 3))}%`;
}

/**
 * Is a position aligned with the asset's regime? A short aligns with a bearish
 * regime; a long aligns with a bullish regime. A neutral regime is treated as
 * aligned (no fight). PURE.
 */
export function isAligned(side: 'long' | 'short', regime: RegimeDir): boolean {
  if (regime === 'neutral') return true;
  return regime === 'bullish' ? side === 'long' : side === 'short';
}

export interface PositionHealthInput {
  side: 'long' | 'short';
  entryPx: number | null;
  markPx: number | null;
  leverage: number | null;
  /** Exchange-supplied liq price (live positions); authoritative when present. */
  liqPxOverride?: number | null;
  regime: RegimeDir;
}

/** Build the per-position health block (alignment + liq distance + bar). PURE. */
export function positionHealth(input: PositionHealthInput): PositionHealth {
  const aligned = isAligned(input.side, input.regime);
  const refPx = input.markPx ?? input.entryPx;

  let liqPx: number | null = input.liqPxOverride ?? null;
  if (liqPx === null && input.entryPx !== null && input.leverage !== null) {
    liqPx = liquidationPrice(input.side, input.entryPx, input.leverage);
  }

  let liqDistPct: number | null = null;
  if (liqPx !== null && refPx !== null && refPx > 0) {
    liqDistPct = (Math.abs(liqPx - refPx) / refPx) * 100;
  }

  return {
    aligned,
    alignLabel: aligned ? 'ALIGNED ✓' : 'FIGHTING ⚠',
    alignColor: aligned ? ZONE_COLORS.ok : ZONE_COLORS.warn,
    liqPx,
    liqDistPct,
    liqBarWidth: liqBarWidth(liqDistPct),
    liqColor: liqColorFor(liqDistPct),
  };
}

/** Unrealized PnL percent off entry notional (sign = direction). PURE. */
export function uPnlPct(
  side: 'long' | 'short',
  entryPx: number | null,
  markPx: number | null,
): number | null {
  if (entryPx === null || markPx === null || entryPx <= 0) return null;
  const dir = side === 'long' ? 1 : -1;
  return ((markPx - entryPx) / entryPx) * 100 * dir;
}

const TAKER_FEE_BPS = 0.00035;

export interface ExitQuote {
  /** Coin units being closed (size × pct). */
  closeSize: number;
  /** Realized PnL net of the taker fee. */
  realizedNetUsd: number;
  /** Gross realized PnL (before fee). */
  realizedGrossUsd: number;
  /** Estimated taker fee on the closed notional. */
  feeUsd: number;
  /** Equity AFTER this close (current equity − the closed-portion unrealized + realized). */
  resultingEquityUsd: number;
}

export interface ExitQuoteInput {
  side: 'long' | 'short';
  size: number;
  entryPx: number;
  markPx: number;
  /** Close fraction in [0, 1]. */
  frac: number;
  /** Equity before the close (cash + all unrealized). */
  currentEquityUsd: number;
}

/**
 * Quote a (partial) close: realized PnL, fee, and resulting equity. PURE.
 *
 *   closeSize     = size × frac
 *   realizedGross = (mark − entry) × closeSize × dir
 *   fee           = mark × closeSize × 0.00035
 *   net           = realizedGross − fee
 *   resultingEq   = currentEquity − closedUnrealized + net
 *                 = currentEquity − fee   (closedUnrealized == realizedGross)
 */
export function quoteExit(input: ExitQuoteInput): ExitQuote {
  const frac = Math.max(0, Math.min(1, input.frac));
  const dir = input.side === 'long' ? 1 : -1;
  const closeSize = input.size * frac;
  const realizedGrossUsd = (input.markPx - input.entryPx) * closeSize * dir;
  const feeUsd = input.markPx * closeSize * TAKER_FEE_BPS;
  const realizedNetUsd = realizedGrossUsd - feeUsd;
  // The closed slice's unrealized (== realizedGross at the mark) converts to
  // realized; net of fee the equity moves by −fee.
  const resultingEquityUsd = input.currentEquityUsd - feeUsd;
  return { closeSize, realizedNetUsd, realizedGrossUsd, feeUsd, resultingEquityUsd };
}
