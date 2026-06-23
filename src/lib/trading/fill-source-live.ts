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
import { submitOrder, submitUpdateLeverage } from '@/lib/hyperliquid/hyperliquid-exchange-service';

export async function liveFill(intent: TradeIntent): Promise<CanonicalFill> {
  // OPENS: set the per-coin leverage on HL FIRST so the cockpit's chosen leverage is
  // REAL on-chain (HL otherwise opens at the account's existing per-coin setting —
  // the silent-20x bug). Reduce-only exits never touch leverage. Fail-closed: if the
  // leverage update is rejected this throws and the order is NOT placed, rather than
  // opening at the wrong (possibly far higher) leverage.
  // ISOLATED margin: the cockpit's liquidation-price / ROE math is isolated-margin,
  // and isolated caps loss to THIS position's margin (a liquidation can't drain the
  // whole account). Cross would make the displayed liq price wrong once a 2nd
  // position exists — exactly the risk-legibility gap to avoid.
  if (!intent.reduceOnly && typeof intent.leverage === 'number' && intent.leverage > 0) {
    await submitUpdateLeverage(intent.coin, intent.leverage, false);
  }
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
