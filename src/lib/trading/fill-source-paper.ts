/**
 * Paper fill source (Phase 0 SKELETON).
 *
 * Phase 1 will: fetch a FRESH l2Book via the HL info REST endpoint, call the
 * pure `matchIntentAgainstBook()` to get fill px/sz, model the fee from HL's
 * published taker/maker schedule, and return a CanonicalFill with
 * `source: 'paper'`. The pure pieces it depends on (orderbook-match, the fee
 * model) already exist; only the I/O (book fetch) is deferred.
 *
 * Returning the SAME CanonicalFill shape as the live source is the whole point
 * (ADR-0001). The signature is final; only the body throws for now.
 */

import type { CanonicalFill, TradeIntent } from '@/types/fill';

export async function paperFill(_intent: TradeIntent): Promise<CanonicalFill> {
  throw new Error('paperFill: not implemented in Phase 0 (Phase 1 builds the book-fetch + match)');
}
