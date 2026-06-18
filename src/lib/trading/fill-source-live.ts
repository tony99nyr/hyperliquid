/**
 * Live fill source (Phase 3) — gated behind TRADING_MODE=live.
 *
 * Submits the intent through the isolated HL exchange service (which signs with
 * the agent/API wallet + POSTs /exchange) and maps the normalized confirmation to
 * the SAME CanonicalFill shape paperFill produces — `source: 'live'` with the real
 * hlOrderId/hlRaw populated, every other field identical in meaning. Everything
 * downstream (persistFill → applyFillToPosition → P&L) is therefore mode-unaware
 * (ADR-0001; pinned by mode-agnosticism.test.ts).
 *
 * The signing/submission I/O lives entirely in hyperliquid-exchange-service.ts;
 * this file is the thin mapping layer (unit-tested with a mocked submitOrder). A
 * zero-fill (IOC didn't cross / rejected → filledSz 0) returns sz:0, which
 * executeIntent declines to persist (the clientIntentId stays free for a retry).
 */

import type { CanonicalFill, TradeIntent } from '@/types/fill';
import { submitOrder } from '@/lib/hyperliquid/hyperliquid-exchange-service';

export async function liveFill(intent: TradeIntent): Promise<CanonicalFill> {
  const result = await submitOrder(intent);

  return {
    clientIntentId: intent.clientIntentId,
    sessionId: intent.sessionId,
    coin: intent.coin,
    side: intent.side,
    px: result.avgPx,
    sz: result.filledSz,
    notionalUsd: result.avgPx * result.filledSz,
    feeUsd: result.feeUsd,
    reduceOnly: intent.reduceOnly,
    partial: result.partial,
    source: 'live',
    hlOrderId: result.hlOrderId,
    hlRaw: result.raw,
    filledAt: Date.now(),
  };
}
