/**
 * PURE client helpers for the LadderBuilderModal (no React, no I/O — fixture-tested).
 *
 * The builder holds a DRAFT in component state; these helpers (1) map a draft rung to
 * the LadderRung shape the shared resolver/risk math consume, (2) compute the live
 * §3.5 risk preview + §2 arm warnings entirely CLIENT-SIDE (the pure functions are
 * import-safe), and (3) build the /api/cockpit/ladder create payload. The server
 * re-validates authoritatively at arm — this is preview only.
 */

import type { LadderRung, LadderSide, RungAction, RungTriggerKind } from '@/lib/ladder/ladder-types';
import { resolveArmRung, validateLadderForArm } from '@/lib/ladder/ladder-arm-business-logic';
import type { LadderRiskRead } from '@/lib/ladder/ladder-risk-business-logic';
import { resolveCoinMaxLeverage } from '@/lib/trading/leverage-business-logic';

/** A rung as the builder form holds it — price-triggered, risk-sized (the common
 *  breakout-ladder case; volume/funding/indicator triggers are a later addition). */
export interface DraftRung {
  coin: string;
  side: LadderSide;
  action: RungAction;
  /** price_above (long breakout) | price_below (short breakdown). */
  triggerKind: Extract<RungTriggerKind, 'price_above' | 'price_below'>;
  triggerPx: number | null;
  riskUsd: number | null;
  stopFrac: number | null;
  leverage: number | null;
  targetPx: number | null;
}

export interface DraftLadder {
  title: string;
  thesis: string;
  mode: 'paper' | 'live';
  maxTotalNotionalUsd: number | null;
  maxTotalLossUsd: number | null;
  /** Hours-from-now the ladder expires (the form picks a duration, not a wall clock). */
  expiresInHours: number;
  rungs: DraftRung[];
}

export function defaultDraftRung(coin = 'ETH'): DraftRung {
  return { coin, side: 'long', action: 'open', triggerKind: 'price_above', triggerPx: null, riskUsd: 50, stopFrac: 0.04, leverage: 5, targetPx: null };
}

export function defaultDraftLadder(coin = 'ETH'): DraftLadder {
  return {
    title: '',
    thesis: '',
    mode: 'paper',
    maxTotalNotionalUsd: 5_000,
    maxTotalLossUsd: 300,
    expiresInHours: 24,
    rungs: [defaultDraftRung(coin)],
  };
}

/** Map a draft rung (+ its 1-based seq) to the LadderRung shape the resolver consumes.
 *  Placeholder id/status/cloid — only the computational fields matter for the preview. */
export function draftRungToLadderRung(r: DraftRung, seq: number): LadderRung {
  return {
    id: `draft-${seq}`,
    ladderId: 'draft',
    seq,
    coin: r.coin,
    side: r.side,
    action: r.action,
    triggerKind: r.triggerKind,
    triggerPx: r.triggerPx,
    triggerMeta: null,
    sizeCoins: null, // risk-sized by resolveArmRung
    reduceFrac: null, // builder authors open/breakout rungs only (no fractional reduce yet)
    riskUsd: r.riskUsd,
    stopFrac: r.stopFrac,
    leverage: r.leverage,
    stopPx: null, // derived from stopFrac by resolveArmRung
    targetPx: r.targetPx,
    status: 'pending',
    cloid: null,
  };
}

export interface LadderPreview {
  risk: LadderRiskRead;
  /** Blocking warnings (empty ⇒ safe to arm). */
  warnings: string[];
}

/**
 * Compute the live preview (risk read + arm warnings) from the draft. PURE — runs the
 * SAME validateLadderForArm the server runs at arm, so the modal can't show "safe" for
 * a ladder the server would reject. `now` is injected (no Date.now in pure code).
 */
export function buildLadderPreview(draft: DraftLadder, now: number): LadderPreview {
  const armRungs = draft.rungs.map((r, i) => resolveArmRung(draftRungToLadderRung(r, i + 1)));
  const { warnings, risk } = validateLadderForArm({
    title: draft.title,
    thesis: draft.thesis,
    expiresAtMs: now + draft.expiresInHours * 3_600_000,
    caps: { maxTotalNotionalUsd: draft.maxTotalNotionalUsd, maxTotalLossUsd: draft.maxTotalLossUsd },
    rungs: armRungs,
    now,
    coinMaxLeverage: (coin) => resolveCoinMaxLeverage(coin, null),
  });
  return { risk, warnings };
}

/** Build the POST /api/cockpit/ladder create body from the draft (+ injected now for expiry). */
export function buildCreatePayload(draft: DraftLadder, now: number) {
  return {
    title: draft.title.trim(),
    thesis: draft.thesis.trim() || null,
    mode: draft.mode,
    maxTotalNotionalUsd: draft.maxTotalNotionalUsd,
    maxTotalLossUsd: draft.maxTotalLossUsd,
    expiresAtMs: now + draft.expiresInHours * 3_600_000,
    rungs: draft.rungs.map((r, i) => ({
      seq: i + 1,
      coin: r.coin,
      side: r.side,
      action: r.action,
      triggerKind: r.triggerKind,
      triggerPx: r.triggerPx,
      riskUsd: r.riskUsd,
      stopFrac: r.stopFrac,
      leverage: r.leverage,
      targetPx: r.targetPx,
    })),
  };
}
