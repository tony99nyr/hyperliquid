/**
 * PURE helpers for the approval popup (no React, no I/O — fixture-tested).
 *
 * The popup must require a STRONGER confirm for LIVE than for paper (parity with
 * the terminal gate, which makes a live order type an exact "side sz coin"
 * phrase). These helpers compute the required phrase and whether what the user
 * typed matches it, plus a one-line proposal summary. Keeping this pure means the
 * "live needs the exact phrase" invariant is unit-tested independent of the DOM.
 */

import type { PendingActionDisplay } from '@/types/cockpit';
import type { TradingMode } from '@/types/fill';

/** The exact phrase a LIVE approval must type: "side sz coin" (lowercased). */
export function liveConfirmPhrase(display: Pick<PendingActionDisplay, 'side' | 'sz' | 'coin'>): string {
  return `${display.side} ${display.sz} ${display.coin}`.trim().toLowerCase();
}

/**
 * Is the Approve button enabled? PAPER: always (one-tap). LIVE: only when the
 * typed phrase exactly matches `liveConfirmPhrase` (case-insensitive, trimmed).
 * This is the popup's equivalent of the terminal exact-phrase rigor.
 */
export function isApproveEnabled(
  mode: TradingMode,
  display: Pick<PendingActionDisplay, 'side' | 'sz' | 'coin'>,
  typed: string,
): boolean {
  if (mode === 'paper') return true;
  return typed.trim().toLowerCase() === liveConfirmPhrase(display);
}

/** One-line human summary of a proposed action for the popup header. */
export function summarizeProposal(display: PendingActionDisplay): string {
  const px = display.estPx != null ? ` @≈$${display.estPx}` : '';
  const stop = display.stopPx != null ? ` · stop $${display.stopPx}` : '';
  return `${display.side.toUpperCase()} ${display.sz} ${display.coin}${px}${stop}`;
}
