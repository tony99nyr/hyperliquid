/**
 * Adjust-leverage I/O seam — push a new per-coin leverage to HL for an open
 * position. Mode-branched like the fill seam (ADR-0001): in LIVE mode it signs +
 * submits the `updateLeverage` action; in PAPER mode leverage is display-only
 * metadata, so there's nothing to push on-chain (no-op).
 *
 * ISOLATED margin (isCross=false) — matches the cockpit's isolated liquidation /
 * ROE math and caps loss to this position's margin. FAIL-CLOSED: a rejected HL
 * action throws, so the caller must NOT persist the new leverage (the cockpit
 * would otherwise display a leverage HL refused). Live-signing I/O is isolated in
 * hyperliquid-exchange-service.ts — this file never touches a key.
 */

import 'server-only';
import { getTradingMode } from '@/lib/env/mode';
import { submitUpdateLeverage } from '@/lib/hyperliquid/hyperliquid-exchange-service';

export interface ApplyLeverageResult {
  /** True when the leverage was actually pushed to HL (live mode). */
  pushed: boolean;
  mode: 'paper' | 'live';
}

/**
 * Set `leverage` for `coin` on HL when live; no-op in paper. Throws on an HL
 * rejection (caller aborts the persist). Leverage is coerced to a positive
 * integer inside submitUpdateLeverage (HL requires an int).
 */
export async function applyLeverageOnHl(coin: string, leverage: number): Promise<ApplyLeverageResult> {
  const mode = getTradingMode();
  if (mode !== 'live') return { pushed: false, mode };
  await submitUpdateLeverage(coin, leverage, false); // isolated
  return { pushed: true, mode };
}
