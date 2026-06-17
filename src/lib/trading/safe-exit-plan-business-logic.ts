/**
 * PURE Safe-Exit PLAN selector — the "smart" upgrade to the dead-man's switch.
 *
 * `buildMarketReduceOnlyClose` (safe-exit-business-logic.ts) is the MECHANICAL
 * fallback: a market reduce-only full close that ALWAYS gets you out. This module
 * is the layer above it: given the live position, a fresh l2 book, and the latest
 * health read, `buildBestExitPlan` chooses the BEST capital-retaining reduce-only
 * exit so the always-on Safe-Exit button is backed by a fresh, smart plan rather
 * than only the worst-case market close.
 *
 * The choice:
 *   - Health adverse/urgent  OR book thin  → MARKET reduce-only (guaranteed out).
 *     Getting out beats price when the position is in trouble or liquidity is
 *     shallow (a limit might not fill and you stay trapped).
 *   - Calm AND book deep                    → LIMIT reduce-only on the FAVORABLE
 *     side (a sell rests at/just above the best bid, a buy at/just below the best
 *     ask), to minimize slippage — slippage is the #1 capital risk (the weETH
 *     $4.3k lesson). The limit only shrinks; reduceOnly is ALWAYS true.
 *
 * No I/O, no clock except the injected `now`, no env. The thin entrypoint
 * (scripts/refresh-exit.ts) fetches the position + book + health and calls this,
 * then upserts the plan. Pinned by
 * tests/lib/trading/safe-exit-plan-business-logic.test.ts.
 */

import type { OrderSide, TradeIntent } from '@/types/fill';
import type { Position } from '@/types/position';
import type { L2Book } from '@/lib/hyperliquid/orderbook-match';

/** The health signals the selector reads (a thin subset of HealthResult). */
export interface ExitPlanHealthContext {
  /** 0–100 composite health score (higher = healthier for the position). */
  score: number;
  /** P(adverse move) — normalized, 0..1. */
  pAdverse: number;
  /** Active alert codes (e.g. 'stop-within-1-ATR', 'regime-flip-8h'). */
  alerts: string[];
}

export interface BuildBestExitInput {
  /** Idempotency key for the resulting intent (caller-generated). */
  clientIntentId: string;
  sessionId: string;
  /** Epoch ms; injected so the selector stays pure. */
  now: number;
  /** Health score at/below this ⇒ treat as adverse → MARKET. Default 45. */
  adverseScore?: number;
  /** P(adverse) at/above this ⇒ treat as urgent → MARKET. Default 0.55. */
  urgentPAdverse?: number;
  /**
   * Minimum coin-units that must rest on the FAVORABLE top-of-book side for the
   * book to count as "deep enough" to rest a limit (else MARKET). Default: the
   * position size — i.e. the best level alone could absorb the whole close.
   */
  minTopLevelDepth?: number;
}

/** Why the selector chose what it chose + whether it's the mechanical fallback. */
export interface BestExitPlan {
  /** The reduce-only exit intent (reduceOnly ALWAYS true). */
  intent: TradeIntent;
  /** 'market' (guaranteed out) | 'limit' (slippage-minimizing rest). */
  style: 'market' | 'limit';
  /** Human-readable rationale for the cockpit + analysis log. */
  reasoning: string;
  /**
   * Always false here — a chosen plan is Claude-authored, not the route's
   * mechanical last-resort fallback (which is built by buildMarketReduceOnlyClose
   * when NO fresh plan exists). Kept on the shape so callers can pass it straight
   * to upsertSafeExitPlan.
   */
  isFallback: false;
}

/** Alerts that, when present, force a guaranteed market exit regardless of score. */
const URGENT_ALERTS = new Set(['stop-within-1-ATR', 'regime-flip-8h', 'decline-detected']);

/** True when the health read says "get out now" (adverse/urgent). PURE. */
export function isHealthAdverse(
  health: ExitPlanHealthContext,
  adverseScore: number,
  urgentPAdverse: number,
): boolean {
  if (health.score <= adverseScore) return true;
  if (health.pAdverse >= urgentPAdverse) return true;
  return health.alerts.some((a) => URGENT_ALERTS.has(a));
}

/**
 * Best (lowest-slippage) resting price for a reduce-only exit on `position`.
 *
 * A LONG closes by SELLING → it rests at the best BID (highest bid) so it fills
 * immediately against the best buyer without crossing down the book. A SHORT
 * closes by BUYING → it rests at the best ASK (lowest ask). Returns null when the
 * needed side of the book is empty (caller falls back to MARKET).
 */
export function favorableLimitPx(position: Position, book: L2Book): number | null {
  if (position.side === 'long') {
    const bid = book.bids[0];
    return bid && bid.px > 0 ? bid.px : null;
  }
  if (position.side === 'short') {
    const ask = book.asks[0];
    return ask && ask.px > 0 ? ask.px : null;
  }
  return null;
}

/** Top-of-book depth (coin units) on the side a reduce-only exit would hit. PURE. */
export function topLevelDepth(position: Position, book: L2Book): number {
  // A long SELLS into bids; a short BUYS from asks.
  const level = position.side === 'long' ? book.bids[0] : book.asks[0];
  return level && level.sz > 0 ? level.sz : 0;
}

/**
 * Choose the best capital-retaining reduce-only exit for an OPEN position.
 *
 * Returns null for a flat / zero-size position (nothing to exit). Otherwise:
 *   - adverse/urgent health OR thin book → MARKET reduce-only full close
 *     (no limitPx → guaranteed book walk, prioritizes getting out).
 *   - calm health AND deep book          → LIMIT reduce-only full close resting at
 *     the favorable top-of-book price (minimizes slippage).
 *
 * The intent is ALWAYS reduceOnly + opposite side + full size (long→sell,
 * short→buy), so it can only shrink/close, never open or flip — identical safety
 * to the mechanical fallback, just smarter on price when conditions allow.
 */
export function buildBestExitPlan(
  position: Position,
  book: L2Book,
  health: ExitPlanHealthContext,
  input: BuildBestExitInput,
): BestExitPlan | null {
  if (position.side === 'flat' || position.sz <= 0) return null;

  const adverseScore = input.adverseScore ?? 45;
  const urgentPAdverse = input.urgentPAdverse ?? 0.55;
  const minDepth = input.minTopLevelDepth ?? position.sz;

  // Opposite side closes the exposure: long → sell, short → buy.
  const side: OrderSide = position.side === 'long' ? 'sell' : 'buy';

  const base = {
    clientIntentId: input.clientIntentId,
    sessionId: input.sessionId,
    coin: position.coin,
    side,
    sz: position.sz,
    reduceOnly: true as const,
    createdAt: input.now,
  };

  const adverse = isHealthAdverse(health, adverseScore, urgentPAdverse);
  const limitPx = favorableLimitPx(position, book);
  const depth = topLevelDepth(position, book);
  const thinBook = limitPx === null || depth < minDepth;

  if (adverse || thinBook) {
    // MARKET reduce-only — guaranteed out (no limitPx → book walk).
    const why = adverse
      ? `health adverse (score ${Math.round(health.score)}/100, P(adverse) ${(health.pAdverse * 100).toFixed(0)}%` +
        `${health.alerts.length ? `, alerts: ${health.alerts.join(', ')}` : ''})`
      : `book thin (top ${depth} < needed ${minDepth} ${position.coin})`;
    return {
      intent: { ...base }, // no limitPx ⇒ market
      style: 'market',
      reasoning: `MARKET reduce-only full close — ${why}. Getting out beats price.`,
      isFallback: false,
    };
  }

  // LIMIT reduce-only resting at the favorable side — minimize slippage while calm.
  return {
    intent: { ...base, limitPx: limitPx as number },
    style: 'limit',
    reasoning:
      `LIMIT reduce-only full close resting at $${limitPx} (favorable ${side === 'sell' ? 'bid' : 'ask'}) — ` +
      `calm (score ${Math.round(health.score)}/100) + deep book (top ${depth} ${position.coin}). ` +
      `Minimizes slippage; the panic button still falls back to a market close if this can't fill.`,
    isFallback: false,
  };
}
