/**
 * Live fill source (Phase 3 SKELETON — gated behind TRADING_MODE=live).
 *
 * Phase 3 will: sign + submit an HL exchange order (EIP-712 / HL scheme,
 * isolated in hyperliquid-exchange-service.ts), read the confirmation, and map
 * it to the SAME CanonicalFill shape the paper source produces, with
 * `source: 'live'` and the real `hlOrderId`/`hlRaw` populated.
 *
 * The signature is final and identical to paperFill so `executeIntent` can swap
 * sources with no downstream change (ADR-0001). Body throws until Phase 3.
 */

import type { CanonicalFill, TradeIntent } from '@/types/fill';

export async function liveFill(_intent: TradeIntent): Promise<CanonicalFill> {
  throw new Error('liveFill: not implemented in Phase 0 (Phase 3 builds HL signed-order submission)');
}
