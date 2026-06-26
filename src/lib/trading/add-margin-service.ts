/**
 * Add-margin I/O seam — post additional ISOLATED margin to an open position on HL
 * to push its liquidation price away (de-risk WITHOUT changing size — the correct,
 * non-martingale way to keep a position healthy). Mode-branched like the fill seam
 * (ADR-0001): LIVE signs + submits `updateIsolatedMargin`; PAPER is display-only
 * (margin is metadata in paper), so there's nothing to push (no-op).
 *
 * FAIL-CLOSED: a rejected HL action throws so the caller surfaces it (e.g. HL's
 * "insufficient margin" when free collateral is short). Live-signing I/O is isolated
 * in hyperliquid-exchange-service.ts — this file never touches a key. ADD-ONLY: the
 * cockpit only posts margin (de-risk); removing margin (which moves liq CLOSER) is
 * intentionally not exposed.
 */

import 'server-only';
import { getTradingMode } from '@/lib/env/mode';
import { submitUpdateIsolatedMargin } from '@/lib/hyperliquid/hyperliquid-exchange-service';

export interface AddMarginResult {
  /** True when margin was actually pushed to HL (live mode). */
  pushed: boolean;
  mode: 'paper' | 'live';
}

/**
 * Add `amountUsd` of isolated margin to the `coin` position on HL when live; no-op
 * in paper. `isBuy` is the POSITION'S side (true=long, false=short). Throws on an HL
 * rejection (caller surfaces the reason). ADD-ONLY: amountUsd must be positive.
 */
export async function addIsolatedMarginOnHl(coin: string, amountUsd: number, isBuy: boolean): Promise<AddMarginResult> {
  const mode = getTradingMode();
  if (mode !== 'live') return { pushed: false, mode };
  await submitUpdateIsolatedMargin(coin, amountUsd, isBuy);
  return { pushed: true, mode };
}
