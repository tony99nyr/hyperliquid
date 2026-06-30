/**
 * PURE ladder risk + arm logic — the numbers that make the preview/arm consent
 * GENUINE (architecture invariant §3.5) and the precondition snapshot that keeps a
 * fire honest (§3.7). No I/O, no keys, no React. Money math delegates to the canonical
 * `isolatedLiqPx` so liq lives in one place.
 *
 * §3.5 — the preview must show: worst-case loss if ALL stops hit at once (NO netting),
 * liq at max aggregate exposure per coin, total notional/margin vs caps. Worst-case
 * uses the SLIPPAGE-BOUNDED stop fill (HL stop = market-on-trigger, not the stop price)
 * — a stop that slips fills worse than its level, so the previewed loss must assume that.
 *
 * §3.7 — a rung fires only if live position state still matches what was approved. We
 * hash {coin, side, exists, leverage} at arm; the fire route re-derives + compares.
 */

import { isolatedLiqPx, MMR } from '@/lib/trading/leverage-business-logic';
import type { LadderRung, LadderSide, RungAction } from './ladder-types';

/** HL stop orders are market-on-trigger with a 10% slippage tolerance. Worst-case
 *  preview assumes the FULL adverse tolerance — the loud, conservative number. */
export const STOP_SLIPPAGE_TOL = 0.1;

/** Defensive clamp on the per-hour funding rate used in the loss-cap estimate. Funding is
 *  fetched as an instantaneous tick and extrapolated across the whole arming window, so an
 *  unclamped transient spike (HL funding is volatile) would balloon into a false breach that
 *  blocks a safe arm. 0.25%/hr is already far above any sane SUSTAINED funding regime. */
export const MAX_FUNDING_RATE_PER_HOUR = 0.0025;

/** The per-rung entry the risk math uses: a price-triggered rung fills at its trigger
 *  level; otherwise the caller supplies an intended entry. */
export function rungEntryPx(rung: Pick<LadderRung, 'triggerKind' | 'triggerPx'>, fallbackPx: number | null): number | null {
  if (rung.triggerKind === 'price_above' || rung.triggerKind === 'price_below') {
    return rung.triggerPx != null && rung.triggerPx > 0 ? rung.triggerPx : fallbackPx;
  }
  return fallbackPx;
}

/** The slippage-bounded WORST stop fill for a side (long stop sells lower; short stop
 *  buys higher). PURE. Returns null for degenerate inputs. */
export function worstStopFill(side: LadderSide, stopPx: number, slipTol: number = STOP_SLIPPAGE_TOL): number | null {
  if (!(stopPx > 0)) return null;
  return side === 'long' ? stopPx * (1 - slipTol) : stopPx * (1 + slipTol);
}

/**
 * Worst-case dollar loss for ONE exposure-increasing rung: the position fills at
 * `entryPx`, the stop fires and SLIPS to its worst bound. Loss = size × adverse move.
 * reduce/close rungs return 0 (they shed risk, they don't add a stoppable loss).
 * Returns 0 when the rung has no stop or degenerate inputs (caller flags "no stop").
 */
export function rungWorstCaseLoss(rung: {
  side: LadderSide;
  action: RungAction;
  entryPx: number | null;
  sizeCoins: number | null;
  stopPx: number | null;
}): number {
  if (rung.action === 'reduce' || rung.action === 'close') return 0;
  if (rung.entryPx == null || !(rung.entryPx > 0) || rung.sizeCoins == null || !(rung.sizeCoins > 0)) return 0;
  if (rung.stopPx == null || !(rung.stopPx > 0)) return 0;
  const fill = worstStopFill(rung.side, rung.stopPx);
  if (fill == null) return 0;
  const adverse = rung.side === 'long' ? rung.entryPx - fill : fill - rung.entryPx;
  return adverse > 0 ? adverse * rung.sizeCoins : 0;
}

/**
 * Estimated funding COST in USD over a holding period (signed: + = the position PAYS,
 * − = it receives). HL funding is charged hourly; a LONG pays when the rate is positive,
 * a SHORT pays when it's negative. PURE. Returns 0 for degenerate inputs. This is an
 * ESTIMATE (rate-now × hours) — funding drifts — but it makes the "max loss" honest for a
 * multi-day perp hold, which a stop-distance-only number is not.
 */
export function expectedFundingUsd(
  notionalUsd: number,
  side: LadderSide,
  fundingRatePerHour: number | null,
  hoursToExpiry: number | null,
): number {
  if (!(notionalUsd > 0)) return 0;
  if (fundingRatePerHour == null || !Number.isFinite(fundingRatePerHour)) return 0;
  if (hoursToExpiry == null || !(hoursToExpiry > 0)) return 0;
  const signedRate = side === 'long' ? fundingRatePerHour : -fundingRatePerHour;
  return notionalUsd * signedRate * hoursToExpiry;
}

/**
 * The fraction of the CURRENT live position a reduce/close rung sheds. `close` is always
 * full (1). A `reduce` prefers `reduceFrac` (path-INDEPENDENT — a fraction of whatever is
 * actually open, robust to which entry rungs filled); else falls back to the absolute
 * `sizeCoins / positionSz`; else full. Clamped to (0, 1]. PURE.
 */
export function reduceFraction(args: {
  action: RungAction;
  reduceFrac: number | null;
  sizeCoins: number | null;
  positionSz: number;
}): number {
  if (args.action === 'close') return 1;
  if (!(args.positionSz > 0)) return 1;
  if (args.reduceFrac != null && args.reduceFrac > 0) return Math.min(1, args.reduceFrac);
  if (args.sizeCoins != null && args.sizeCoins > 0) return Math.min(1, args.sizeCoins / args.positionSz);
  return 1;
}

/** A rung resolved to the numbers the risk read needs (caller maps LadderRung→this,
 *  filling entryPx/sizeCoins from triggerPx + risk-sizing as needed). */
export interface RungRisk {
  coin: string;
  side: LadderSide;
  action: RungAction;
  entryPx: number | null;
  sizeCoins: number | null;
  leverage: number | null;
  stopPx: number | null;
}

export interface PerCoinExposure {
  coin: string;
  side: LadderSide;
  /** Σ size across this coin's exposure-increasing rungs. */
  totalSizeCoins: number;
  /** Notional-weighted blended entry (Σ entry·size / Σ size). */
  blendedEntryPx: number;
  /** Aggregate notional (USD) at full exposure. */
  notionalUsd: number;
  /** Shared per-coin leverage (HL is per-coin); null if the rungs disagree. */
  leverage: number | null;
  /** Liq at max aggregate exposure (blended entry + shared leverage), or null. */
  aggregateLiqPx: number | null;
}

/**
 * Per-(coin, side) aggregate exposure across the ladder's OPEN/ADD rungs. Grouped by
 * coin AND side so a long leg and a short leg on the same coin NEVER blend into one
 * fictional directional position with a single fake liq (each leg keeps its own real
 * liq); the validator separately flags mixed-side-on-one-coin (HL nets per coin).
 * Blends entry by size, liq at the max aggregate exposure using the shared leverage. PURE.
 */
export function perCoinExposure(rungs: RungRisk[]): PerCoinExposure[] {
  const groups = new Map<string, RungRisk[]>();
  for (const r of rungs) {
    if (r.action === 'reduce' || r.action === 'close') continue;
    if (r.entryPx == null || !(r.entryPx > 0) || r.sizeCoins == null || !(r.sizeCoins > 0)) continue;
    const key = `${r.coin.toUpperCase()}|${r.side}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const out: PerCoinExposure[] = [];
  for (const rs of groups.values()) {
    const totalSize = rs.reduce((a, r) => a + (r.sizeCoins ?? 0), 0);
    const weighted = rs.reduce((a, r) => a + (r.entryPx ?? 0) * (r.sizeCoins ?? 0), 0);
    const blendedEntry = totalSize > 0 ? weighted / totalSize : 0;
    // Per-coin leverage must be ONE value (HL constraint, enforced at arm). If the
    // rungs disagree, leverage is null → liq can't be computed (the validator blocks it).
    const levs = new Set(rs.map((r) => r.leverage ?? null));
    const leverage = levs.size === 1 ? (rs[0].leverage ?? null) : null;
    const side = rs[0].side;
    out.push({
      coin: rs[0].coin.toUpperCase(),
      side,
      totalSizeCoins: totalSize,
      blendedEntryPx: blendedEntry,
      notionalUsd: blendedEntry * totalSize,
      leverage,
      aggregateLiqPx: leverage != null ? isolatedLiqPx(side, blendedEntry, leverage, MMR) : null,
    });
  }
  return out;
}

export interface LadderCaps {
  maxTotalNotionalUsd: number | null;
  maxTotalLossUsd: number | null;
}

export interface LadderRiskRead {
  /** Σ notional across exposure-increasing rungs (USD). */
  totalNotionalUsd: number;
  /** Σ margin (notional / leverage) across exposure-increasing rungs (USD). */
  totalMarginUsd: number;
  /** Σ per-rung worst-case loss with ALL stops slipping at once — NO netting (§3.5). */
  aggregateWorstCaseLossUsd: number;
  /** Estimated funding cost (USD, signed: + = position pays) over the holding period.
   *  0 unless the caller supplies funding rates + hoursToExpiry. */
  expectedFundingUsd: number;
  /** The honest max loss: worst-case stop loss + funding cost (a credit doesn't reduce it). */
  worstCaseLossWithFundingUsd: number;
  perCoin: PerCoinExposure[];
  /** Cap/consistency breaches that BLOCK arming (each a human-readable line). */
  breaches: string[];
}

/**
 * The full preview risk read for a ladder (§3.5). Sums notional/margin, the no-netting
 * worst-case loss, per-coin liq at max exposure, and flags cap + per-coin-leverage
 * breaches. PURE — the route/modal render it; the typed-phrase consent rests on it.
 */
export function computeLadderRisk(
  rungs: RungRisk[],
  caps: LadderCaps,
  opts?: { hoursToExpiry?: number | null; fundingRateByCoin?: Record<string, number | null> },
): LadderRiskRead {
  const breaches: string[] = [];
  let totalNotional = 0;
  let totalMargin = 0;
  let worstCase = 0;
  // Track exposure rungs per coin to flag coin-level invariants (mixed side / split
  // leverage) — HL nets per coin, so neither can be silently blended in the read.
  const sidesByCoin = new Map<string, Set<string>>();
  const levsByCoin = new Map<string, Set<number | null>>();

  for (const r of rungs) {
    if (r.action === 'reduce' || r.action === 'close') continue;
    const coin = r.coin.toUpperCase();
    (sidesByCoin.get(coin) ?? sidesByCoin.set(coin, new Set()).get(coin)!).add(r.side);
    (levsByCoin.get(coin) ?? levsByCoin.set(coin, new Set()).get(coin)!).add(r.leverage ?? null);
    if (r.entryPx != null && r.entryPx > 0 && r.sizeCoins != null && r.sizeCoins > 0) {
      const notional = r.entryPx * r.sizeCoins;
      totalNotional += notional;
      if (r.leverage != null && r.leverage > 0) totalMargin += notional / r.leverage;
      // An exposure rung with NO valid protective stop has an UNBOUNDED worst-case
      // loss — it contributes 0 to the sum, so flag it loudly rather than let the
      // preview render $0 and silently pass the loss cap (risk understatement).
      if (r.stopPx == null || !(r.stopPx > 0)) {
        breaches.push(`${coin}: an open/add rung has no protective stop — worst-case loss is UNBOUNDED, not $0.`);
      }
    }
    worstCase += rungWorstCaseLoss(r);
  }

  // Coin-level invariants (HL is per-coin).
  for (const [coin, sides] of sidesByCoin) {
    if (sides.size > 1) {
      breaches.push(`${coin}: has both long and short rungs — HL nets exposure per coin; a single coin can't hold opposing legs (delta-neutral is P3).`);
    }
  }
  for (const [coin, levs] of levsByCoin) {
    if (levs.size > 1) {
      breaches.push(`${coin}: rungs disagree on leverage (HL is per-coin — all ${coin} rungs must share one).`);
    }
  }

  const perCoin = perCoinExposure(rungs);

  // Estimated funding over the holding period (per-coin — HL funding is per-coin). 0 unless
  // the caller supplies both hoursToExpiry and a funding-rate map. Two numbers come out:
  //  • signedFunding — informational (+ = the book pays, − = it net-receives);
  //  • fundingCost   — what the LOSS CAP uses: each coin's funding floored at 0 INDEPENDENTLY,
  //    so a credit on one coin can never mask a cost on another (the consent surface must not
  //    be understated for a multi-coin, mixed-sign ladder).
  // The per-hour rate is CLAMPED first: funding is an instantaneous tick extrapolated across
  // the whole arming window, so an unclamped transient spike (HL funding is volatile) would
  // otherwise extrapolate to an absurd cost and FALSELY block a safe arm. NOTE: hoursToExpiry
  // is the ARMING window, not the eventual hold — this is a within-window estimate.
  let signedFunding = 0;
  let fundingCost = 0;
  const hoursToExpiry = opts?.hoursToExpiry ?? null;
  const fundingByCoin = opts?.fundingRateByCoin ?? null;
  if (hoursToExpiry != null && hoursToExpiry > 0 && fundingByCoin) {
    for (const pc of perCoin) {
      const raw = fundingByCoin[pc.coin] ?? null;
      const clamped = raw == null ? null : Math.max(-MAX_FUNDING_RATE_PER_HOUR, Math.min(MAX_FUNDING_RATE_PER_HOUR, raw));
      const f = expectedFundingUsd(pc.notionalUsd, pc.side, clamped, hoursToExpiry);
      signedFunding += f;
      fundingCost += Math.max(0, f);
    }
  }
  const lossWithFunding = worstCase + fundingCost;

  if (caps.maxTotalNotionalUsd != null && totalNotional > caps.maxTotalNotionalUsd) {
    breaches.push(`Total notional $${totalNotional.toFixed(0)} exceeds the cap $${caps.maxTotalNotionalUsd.toFixed(0)}.`);
  }
  if (caps.maxTotalLossUsd != null && lossWithFunding > caps.maxTotalLossUsd) {
    if (fundingCost > 0) {
      breaches.push(`Worst-case loss $${worstCase.toFixed(0)} (all stops slipping) + ~$${fundingCost.toFixed(0)} est. funding = $${lossWithFunding.toFixed(0)} exceeds the cap $${caps.maxTotalLossUsd.toFixed(0)}.`);
    } else {
      breaches.push(`Worst-case loss $${worstCase.toFixed(0)} (all stops slipping) exceeds the cap $${caps.maxTotalLossUsd.toFixed(0)}.`);
    }
  }

  return {
    totalNotionalUsd: totalNotional,
    totalMarginUsd: totalMargin,
    aggregateWorstCaseLossUsd: worstCase,
    expectedFundingUsd: signedFunding,
    worstCaseLossWithFundingUsd: lossWithFunding,
    perCoin,
    breaches,
  };
}

/** Live position state for the precondition snapshot (§3.7). */
export interface LivePositionState {
  coin: string;
  side: LadderSide;
  /** Effective per-coin leverage at arm time (rounded for a stable hash). */
  leverage: number | null;
}

/**
 * Build the arm-time precondition snapshot string (§3.7) over the live positions for
 * the coins this ladder TOUCHES with an add/reduce/close (rungs that depend on an
 * existing position). A plain `open` rung depends on no prior state, so it's excluded.
 *
 * CRITICAL: a coin the LADDER ITSELF opens (it has an `open` rung for that coin) is also
 * excluded — its add/reduce depend on the ladder's OWN open, NOT on external state. Were it
 * included, a self-contained open→add pyramid armed while FLAT would snapshot `COIN:none`,
 * then the open creates the position, and the add's fire would see `COIN:side:lev` ≠ `none`
 * → auto-disarm before the add can ever fire. The precondition guards add/reduce on
 * positions the ladder does NOT open (e.g. an add-to-an-existing-position ladder); the
 * runtime add-coverage gate is what protects a self-opened pyramid's adds.
 *
 * Canonical: coins sorted, leverage rounded to 1dp. The fire route re-derives this and
 * compares — any drift (side flip, position vanished, leverage changed) → auto-disarm.
 */
export function buildPreconditionSnapshot(rungs: Pick<LadderRung, 'coin' | 'action'>[], live: LivePositionState[]): string {
  const selfOpenedCoins = new Set(rungs.filter((r) => r.action === 'open').map((r) => r.coin.toUpperCase()));
  const dependentCoins = new Set(
    rungs
      .filter((r) => (r.action === 'add' || r.action === 'reduce' || r.action === 'close') && !selfOpenedCoins.has(r.coin.toUpperCase()))
      .map((r) => r.coin.toUpperCase()),
  );
  const liveByCoin = new Map(live.map((l) => [l.coin.toUpperCase(), l]));
  const parts: string[] = [];
  for (const coin of [...dependentCoins].sort()) {
    const l = liveByCoin.get(coin);
    if (!l) {
      parts.push(`${coin}:none`); // depended-on position does NOT exist at arm
    } else {
      const lev = l.leverage != null ? l.leverage.toFixed(1) : 'na';
      parts.push(`${coin}:${l.side}:${lev}`);
    }
  }
  return parts.join('|');
}

/**
 * The §2 RUNTIME pyramiding guardrail (enforced at FIRE, not arm — it needs live PnL):
 * an exposure-INCREASING add fires only if its worst-case loss is fully covered by the
 * existing position's CURRENT unrealized profit. A flat/losing position (profit ≤ 0)
 * can never cover an add → refused. This is the inviolable "risk covered by profit"
 * rule that separates disciplined pyramiding from martingale averaging-up. PURE.
 */
export function addRiskCoveredByProfit(addWorstCaseLossUsd: number, unrealizedProfitUsd: number): boolean {
  if (!(unrealizedProfitUsd > 0)) return false;
  if (!(addWorstCaseLossUsd >= 0)) return false;
  return addWorstCaseLossUsd <= unrealizedProfitUsd;
}

/** Deterministic, dependency-free string hash (FNV-1a, 32-bit) for the precondition
 *  snapshot — pure, stable across processes (no crypto / Date needed). */
export function hashPreconditionSnapshot(snapshot: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < snapshot.length; i++) {
    h ^= snapshot.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
