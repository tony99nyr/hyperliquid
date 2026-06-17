/**
 * PURE helpers for the approval popup (no React, no I/O — fixture-tested).
 *
 * The popup must require a STRONGER confirm for LIVE than for paper (parity with
 * the terminal gate, which makes a live order type an exact "side sz coin"
 * phrase). These helpers compute the required phrase and whether what the user
 * typed matches it, plus a one-line proposal summary. Keeping this pure means the
 * "live needs the exact phrase" invariant is unit-tested independent of the DOM.
 */

import type { PendingActionDisplay, PendingActionKind } from '@/types/cockpit';
import type { TradingMode } from '@/types/fill';
import { fmtPx } from './panel-styles';

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

/** Human label for the action kind shown in the summary. */
function kindLabel(kind: PendingActionKind, reduceOnly: boolean): string {
  if (reduceOnly) return 'reduce-only';
  return kind === 'entry' ? 'entry' : kind === 'exit' ? 'exit' : 'action';
}

/**
 * One-line human summary of a proposed action for the popup header. Prices are
 * formatted via the shared `fmtPx` locale helper (variable precision, no raw
 * numbers). When `kind`/`mode` are supplied, the summary also tags the action
 * type (entry / exit / reduce-only) and the trading mode (PAPER/LIVE) so the
 * operator sees WHAT KIND of order this is and which book it hits.
 */
export function summarizeProposal(
  display: PendingActionDisplay,
  opts?: { kind?: PendingActionKind; mode?: TradingMode; reduceOnly?: boolean },
): string {
  const px = display.estPx != null ? ` @≈${fmtPx(display.estPx)}` : '';
  const stop = display.stopPx != null ? ` · stop ${fmtPx(display.stopPx)}` : '';
  const core = `${display.side.toUpperCase()} ${display.sz} ${display.coin}${px}${stop}`;
  if (!opts?.kind && !opts?.mode) return core;
  const tags: string[] = [];
  if (opts.kind) tags.push(kindLabel(opts.kind, opts.reduceOnly ?? false));
  if (opts.mode) tags.push(opts.mode === 'live' ? 'LIVE' : 'PAPER');
  return tags.length ? `${core} (${tags.join(' · ')})` : core;
}
