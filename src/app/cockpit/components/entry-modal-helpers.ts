/**
 * PURE helpers for the self-service EntryModal (no React, no I/O — fixture-tested).
 *
 * The "＋ New Position" entry path lets the operator hand-build an OPENING order
 * in the cockpit (parallel to the Claude-skill → pending_action → approval-popup
 * path). These helpers compute the validated open proposal preview off the form
 * state, the LIVE typed-confirm phrase, and whether Approve is enabled — keeping
 * the safety invariants (risk-based sizing, liquidation-inside-stop gate, LIVE
 * exact-phrase rigor) unit-testable independent of the DOM.
 *
 * The sizing comes straight from `buildOpenProposal` (the SAME builder the skill
 * uses) so the self-service path and the skill path size identically.
 */

import type { OrderSide, TradingMode } from '@/types/fill';
import { buildOpenProposal, type OpenProposal } from '@/lib/skills/open-position-business-logic';
import { clampLeverage, deriveLeverageRead, liquidationInsideStop } from '@/lib/trading/leverage-business-logic';

/** The coins the self-service entry form offers. */
export const ENTRY_COINS = ['ETH', 'BTC', 'HYPE'] as const;
export type EntryCoin = (typeof ENTRY_COINS)[number];

/** The mutable form state the modal owns. */
export interface EntryFormState {
  coin: string;
  side: OrderSide;
  /** Account/risk budget for this trade (USD). */
  riskUsd: number;
  /** Stop distance as a fraction of entry (e.g. 0.04 = 4%). */
  stopFrac: number;
  /** Operator-chosen leverage (metadata for ROE; bounded by coinMax). */
  leverage: number;
  /** The thesis the operator is betting on. */
  thesis: string;
}

/** Sensible defaults the modal opens with. */
export function defaultEntryForm(coin: string): EntryFormState {
  return {
    coin: coin.trim().toUpperCase() || 'ETH',
    side: 'buy',
    riskUsd: 50,
    stopFrac: 0.04,
    leverage: 3,
    thesis: '',
  };
}

/**
 * Build the live preview proposal from the form + the current entry price.
 * Returns null when the entry price is unknown (the modal then shows "—" and
 * blocks Approve). Sizing is RISK-BASED via the shared builder — leverage is
 * metadata only. `clientIntentId`/`now` are placeholders here (the preview is
 * not executed); the route mints the real ones.
 */
export function buildEntryPreview(
  form: EntryFormState,
  entryPx: number | null,
): OpenProposal | null {
  if (entryPx == null || !(entryPx > 0)) return null;
  return buildOpenProposal({
    sessionId: 'preview',
    coin: form.coin,
    side: form.side,
    entryPx,
    riskUsd: form.riskUsd,
    stopDistanceFrac: form.stopFrac,
    leverage: form.leverage,
    clientIntentId: 'preview',
    now: 0,
    // Thesis is OPTIONAL in the self-service path (the route defaults it the same
    // way). Fall back to a generated one so the builder's "thesis required"
    // warning never blocks Approve for an otherwise-valid setup.
    thesis: defaultThesis(form),
  });
}

/** The thesis used when the operator leaves it blank — mirrors the route default. */
export function defaultThesis(form: EntryFormState): string {
  const t = form.thesis.trim();
  return t || `Manual ${form.side === 'buy' ? 'long' : 'short'} ${form.coin.trim().toUpperCase()}`;
}

/** The derived leverage read (margin / liq / ROE) for the preview, or null. */
export function entryLeverageRead(
  form: EntryFormState,
  proposal: OpenProposal | null,
  entryPx: number | null,
) {
  if (!proposal || entryPx == null) return null;
  return deriveLeverageRead({
    side: form.side,
    entryPx,
    sz: proposal.intent.sz,
    leverage: form.leverage,
    stopPx: proposal.stopPx,
  });
}

/**
 * Is the proposal in a state that is SAFE to submit? It must:
 *  - have a known entry price + a positive computed size;
 *  - carry no builder warnings (bad risk/stop/thesis);
 *  - clear the liquidation-inside-stop gate (warning resolved by reducing
 *    leverage OR an explicit acknowledge).
 * This mirrors the approval-popup gate so both entry paths share the invariant.
 */
export function entryProposalReady(
  proposal: OpenProposal | null,
  liqInsideStop: boolean,
  ackLiqInsideStop: boolean,
): boolean {
  if (!proposal) return false;
  if (proposal.warnings.length > 0) return false;
  if (proposal.intent.sz <= 0) return false;
  return !liqInsideStop || ackLiqInsideStop;
}

/**
 * The exact phrase a LIVE entry must type: "side coin" (lowercased). Deliberately
 * does NOT include the size: the size is risk-based and RECOMPUTES every price tick,
 * so putting it in the phrase made it a moving target the operator could never
 * match. Confirming direction + asset (with the size shown in the summary + the LIVE
 * banner) is the safety gate; the size is not a fat-finger field.
 */
export function entryLiveConfirmPhrase(side: OrderSide, coin: string): string {
  return `${side} ${coin}`.trim().toLowerCase();
}

/** True when the typed phrase exactly matches the required LIVE phrase. */
export function entryLivePhraseMatches(side: OrderSide, coin: string, typed: string): boolean {
  return typed.trim().toLowerCase() === entryLiveConfirmPhrase(side, coin);
}

/**
 * Is Approve enabled? PAPER: ready proposal + liq gate clear. LIVE: ALL of that
 * PLUS the exact typed phrase (the stronger live confirm). Mirrors the
 * approval-popup `isApproveEnabled` + liq-gate composition.
 */
export function isEntryApproveEnabled(
  mode: TradingMode,
  proposal: OpenProposal | null,
  liqInsideStop: boolean,
  ackLiqInsideStop: boolean,
  typed: string,
): boolean {
  if (!entryProposalReady(proposal, liqInsideStop, ackLiqInsideStop)) return false;
  if (mode === 'paper') return true;
  if (!proposal) return false;
  return entryLivePhraseMatches(proposal.intent.side, proposal.intent.coin, typed);
}

/** Compute whether the form's leverage would liquidate inside the stop. */
export function entryLiqInsideStop(
  form: EntryFormState,
  proposal: OpenProposal | null,
  entryPx: number | null,
): boolean {
  const read = entryLeverageRead(form, proposal, entryPx);
  if (!read || !proposal) return false;
  return liquidationInsideStop(form.side, read.liqPx, proposal.stopPx);
}

/** Re-export the clamp so the modal bounds the slider without a second import. */
export { clampLeverage };
