/**
 * open-position — PURE intent-builder + sizing/stop logic (fixture-tested).
 *
 * Given a user-chosen setup, constructs the proposed TradeIntent plus the stop
 * price, dollar risk and a rationale. The script (scripts/open-position.ts)
 * presents this proposal and REQUIRES EXPLICIT user confirmation before calling
 * executeIntent. This module NEVER executes — it only proposes.
 *
 * No I/O, no clock except the injected `now`, no env. Fully deterministic.
 */

import type { OrderSide, TradeIntent } from '@/types/fill';

/** What the user chose, in human terms. */
export interface OpenSetupInput {
  sessionId: string;
  coin: string;
  side: OrderSide;
  /** Current mark / intended entry price (USD). */
  entryPx: number;
  /** Account/risk budget for this trade (USD) the user is willing to lose. */
  riskUsd: number;
  /** Stop distance as a fraction of entry (e.g. 0.04 = 4% adverse move). */
  stopDistanceFrac: number;
  /** Optional limit price; omit for a market order. */
  limitPx?: number;
  /**
   * Position leverage (e.g. 5 = 5x). METADATA carried onto the intent so the
   * positions row stores it for ROE; it does NOT change the risk-based sizing
   * (sizing is driven by riskUsd + stopDistanceFrac, leverage-independent).
   * Defaults to 1 (unleveraged) when omitted.
   */
  leverage?: number;
  /** Idempotency key (caller-generated, identical across retries + modes). */
  clientIntentId: string;
  /** Epoch ms; injected so the builder stays pure. */
  now: number;
  /** The thesis the user is betting on (becomes the hypothesis row). */
  thesis: string;
}

/** The proposal surfaced to the user for confirmation. */
export interface OpenProposal {
  intent: TradeIntent;
  /** Computed stop price (USD). */
  stopPx: number;
  /** Position notional at entry (USD). */
  notionalUsd: number;
  /** Dollar risk if the stop is hit (≈ riskUsd by construction). */
  dollarRisk: number;
  /** Implied leverage is NOT computed here (account value unknown); sizing is
   *  risk-based: sz = riskUsd / (entryPx * stopDistanceFrac). */
  rationale: string;
  /** Any validation problems; a non-empty list means the proposal is not safe to confirm. */
  warnings: string[];
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Build the open-position proposal. PURE. Sizing is risk-based: the size is
 * chosen so that hitting the stop loses approximately `riskUsd`. A long stops
 * below entry; a short stops above. Returns warnings (never throws) so the
 * script can refuse to confirm rather than crash.
 */
export function buildOpenProposal(input: OpenSetupInput): OpenProposal {
  const warnings: string[] = [];

  if (input.entryPx <= 0) warnings.push('entryPx must be positive.');
  if (input.riskUsd <= 0) warnings.push('riskUsd must be positive.');
  if (input.stopDistanceFrac <= 0 || input.stopDistanceFrac >= 1) {
    warnings.push('stopDistanceFrac must be in (0, 1).');
  }
  if (!input.thesis.trim()) warnings.push('A thesis is required (it becomes the tracked hypothesis).');

  const safeEntry = input.entryPx > 0 ? input.entryPx : 1;
  const safeStopFrac = input.stopDistanceFrac > 0 && input.stopDistanceFrac < 1 ? input.stopDistanceFrac : 0.04;
  // Leverage is metadata for ROE only; default to 1 (unleveraged). Reject a
  // non-positive value rather than silently coercing — a leverage typo should
  // surface, not be swallowed.
  if (input.leverage !== undefined && (!Number.isFinite(input.leverage) || input.leverage <= 0)) {
    warnings.push('leverage must be a positive number (e.g. 5 for 5x).');
  }
  const leverage = input.leverage !== undefined && input.leverage > 0 ? input.leverage : 1;

  // A long is protected by a stop BELOW entry; a short by a stop ABOVE.
  const stopPx =
    input.side === 'buy'
      ? round(safeEntry * (1 - safeStopFrac), 6)
      : round(safeEntry * (1 + safeStopFrac), 6);

  // Risk per coin = |entry - stop| = entry * stopDistanceFrac. Size so total
  // adverse move ≈ riskUsd.
  const riskPerCoin = safeEntry * safeStopFrac;
  const rawSz = riskPerCoin > 0 ? input.riskUsd / riskPerCoin : 0;
  const sz = round(rawSz, 6);
  if (sz <= 0) warnings.push('Computed size is zero — check riskUsd / stopDistanceFrac.');

  // If a limit price is supplied it must not be worse than the entry side.
  if (input.limitPx !== undefined) {
    if (input.side === 'buy' && input.limitPx < input.entryPx) {
      warnings.push('Buy limit is below entry — fill may not occur at the assumed price.');
    }
    if (input.side === 'sell' && input.limitPx > input.entryPx) {
      warnings.push('Sell limit is above entry — fill may not occur at the assumed price.');
    }
  }

  const notionalUsd = round(sz * safeEntry, 2);
  const dollarRisk = round(sz * riskPerCoin, 2);

  const intent: TradeIntent = {
    clientIntentId: input.clientIntentId,
    sessionId: input.sessionId,
    coin: input.coin.trim().toUpperCase(),
    side: input.side,
    sz,
    limitPx: input.limitPx,
    reduceOnly: false, // opening a position is never reduce-only
    leverage,
    createdAt: input.now,
  };

  const dirWord = input.side === 'buy' ? 'LONG' : 'SHORT';
  const levWord = leverage > 1 ? ` ${leverage}x` : '';
  const rationale =
    `${dirWord}${levWord} ${sz} ${intent.coin} @ ~$${safeEntry} ` +
    `(notional $${notionalUsd}); stop $${stopPx} (${round(safeStopFrac * 100, 2)}% away), ` +
    `risking $${dollarRisk}. Thesis: ${input.thesis.trim()}`;

  return { intent, stopPx, notionalUsd, dollarRisk, rationale, warnings };
}
