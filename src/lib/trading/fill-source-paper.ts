/**
 * Paper fill source (Phase 1a — implemented).
 *
 * Fetches a FRESH l2Book via the HL info REST endpoint (NEVER a stale one —
 * ADR-0001/0004), runs the PURE `matchIntentAgainstBook()` to get the fill
 * px/sz (a market order walks the book; a limit order respects its price), and
 * models the taker fee from HL's published schedule (paper-fee-model.ts). Returns
 * a CanonicalFill with `source: 'paper'` and null HL metadata — the EXACT same
 * shape the live source produces, so everything downstream (persistFill →
 * applyFillToPosition → P&L) is identical and mode-unaware (ADR-0001).
 */

import type { CanonicalFill, TradeIntent } from '@/types/fill';
import { fetchL2Book } from '@/lib/hyperliquid/hyperliquid-info-service';
import { matchIntentAgainstBook } from '@/lib/hyperliquid/orderbook-match';
import { applyFillRealism, bandDepthUsd, baseSlippageBps } from './paper-fill-realism-business-logic';
import { modelFeeUsd } from './paper-fee-model';

export async function paperFill(intent: TradeIntent): Promise<CanonicalFill> {
  // Fresh book each time — a stale book makes paper P&L drift from reality.
  const book = await fetchL2Book(intent.coin);

  const match = matchIntentAgainstBook(intent.side, intent.sz, book, intent.limitPx);

  // Realism: clamp to no-better-than the decision mark (kill favorable-selection),
  // then apply size/depth-scaled adverse slippage so the recorded fill price (and
  // thus realized P&L) is conservative, not optimistic. The raw book VWAP would
  // inflate P&L upstream of any scorecard haircut.
  const realism = applyFillRealism({
    side: intent.side,
    bookAvgPx: match.avgPx,
    decisionPx: intent.decisionPx ?? null,
    filledNotionalUsd: match.notionalUsd,
    bandDepthUsd: bandDepthUsd(intent.side, book),
    baseBps: baseSlippageBps(intent.coin),
  });
  const px = realism.effectivePx;
  const notionalUsd = px * match.filledSz;

  // A taker walks resting liquidity; fee is charged only on what actually filled.
  const feeUsd = modelFeeUsd(notionalUsd, 'taker');

  return {
    clientIntentId: intent.clientIntentId,
    sessionId: intent.sessionId,
    coin: intent.coin,
    side: intent.side,
    px,
    sz: match.filledSz,
    notionalUsd,
    feeUsd,
    reduceOnly: intent.reduceOnly,
    partial: match.partial,
    source: 'paper',
    hlOrderId: null,
    hlRaw: null,
    filledAt: Date.now(),
  };
}
