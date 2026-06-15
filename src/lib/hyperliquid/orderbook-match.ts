/**
 * Order-book matching (PURE). Powers paper fills: walk a fresh l2Book snapshot
 * to compute the fill price/size a market or limit order WOULD get. No I/O —
 * the caller fetches the book and hands it in (see fill-source-paper.ts).
 *
 * See ADR-0001 (paper fills must use a FRESH book) and ADR-0003.
 */

import type { OrderSide } from '@/types/fill';

/** One price level: price + size available at that price. */
export interface BookLevel {
  px: number;
  sz: number;
}

/**
 * Hyperliquid l2Book shape (normalized): `bids` sorted best (highest) first,
 * `asks` sorted best (lowest) first. A buy lifts asks; a sell hits bids.
 */
export interface L2Book {
  coin: string;
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface MatchResult {
  /** Volume-weighted average fill price. 0 when nothing filled. */
  avgPx: number;
  /** Total filled size in coin units (<= requested). */
  filledSz: number;
  /** Notional filled (USD) = sum(level px * level sz consumed). */
  notionalUsd: number;
  /** True when the book could not fully fill the requested size. */
  partial: boolean;
  /** Per-level breakdown of what was consumed (for audit/debug). */
  consumed: BookLevel[];
}

/**
 * Match an intent's size against the book.
 *
 * @param side    buy walks asks (ascending), sell walks bids (descending).
 * @param sz      requested size in coin units (must be > 0).
 * @param book    fresh l2Book snapshot.
 * @param limitPx optional limit — buys won't pay above it, sells won't accept
 *                below it. Omit for a pure market order.
 *
 * Walks levels in price-priority order, consuming size until the request is
 * filled or the book/limit is exhausted (then `partial: true`).
 */
export function matchIntentAgainstBook(
  side: OrderSide,
  sz: number,
  book: L2Book,
  limitPx?: number,
): MatchResult {
  const empty: MatchResult = {
    avgPx: 0,
    filledSz: 0,
    notionalUsd: 0,
    partial: true,
    consumed: [],
  };

  if (!(sz > 0)) return { ...empty, partial: false };

  // Buy consumes asks (cheapest first); sell consumes bids (highest first).
  const levels = side === 'buy' ? book.asks : book.bids;
  if (!levels || levels.length === 0) return empty;

  let remaining = sz;
  let notionalUsd = 0;
  const consumed: BookLevel[] = [];

  for (const level of levels) {
    if (remaining <= 0) break;

    // Respect the limit price: a buy stops once asks exceed the limit; a sell
    // stops once bids fall below the limit. Book is price-ordered, so we can
    // stop walking entirely at the first crossing level.
    if (limitPx !== undefined) {
      if (side === 'buy' && level.px > limitPx) break;
      if (side === 'sell' && level.px < limitPx) break;
    }

    if (!(level.sz > 0)) continue;

    const take = Math.min(remaining, level.sz);
    notionalUsd += take * level.px;
    consumed.push({ px: level.px, sz: take });
    remaining -= take;
  }

  const filledSz = sz - remaining;
  if (filledSz <= 0) return empty;

  return {
    avgPx: notionalUsd / filledSz,
    filledSz,
    notionalUsd,
    partial: remaining > 1e-12,
    consumed,
  };
}
