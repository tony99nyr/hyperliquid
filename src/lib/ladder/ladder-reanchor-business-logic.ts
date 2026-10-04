/**
 * ladder re-anchor — PURE. Scales a DRAFT ladder's price levels from the drafter's
 * stored anchor mark to the live mark, preserving every ratio (and therefore the
 * dollar risk: riskUsd/stopFrac are untouched, so notional is fill-invariant).
 *
 * Why: the drafters price every rung as a fixed ratio of the mark at detection.
 * By arm time the market has often moved through a gate, the arm route's
 * instant-fire guard (correctly) refuses, and the draft is un-armable without a
 * manual DB edit (three incidents by 2026-10-03). Re-anchor is the cockpit fix:
 * a DRAFT-ONLY edit that moves no money and re-prices the plan to the live mark.
 * The operator still reviews the fresh numbers and arms — consent stays honest.
 *
 * Only drafter ladders re-anchor (anchor stored at create). A manual draft's
 * levels are STRUCTURAL (a base, a support), not ratios — scaling them would
 * detach the plan from the real levels, so the caller refuses when anchor is null.
 */

import type { LadderRung, RungTriggerMeta } from './ladder-types';

/** The per-rung price rewrite applied by the draft re-anchor service write. */
export interface ReanchorRungPatch {
  rungId: string;
  triggerPx: number | null;
  stopPx: number | null;
  targetPx: number | null;
  triggerMeta: RungTriggerMeta | null;
}

export type ReanchorOutcome =
  | { ok: true; factor: number; patches: ReanchorRungPatch[] }
  | { ok: false; reason: string };

/** Refuse to scale across a move this large: a ±50% drift means the draft premise
 *  is dead and the plan should be RE-DRAFTED, not mechanically re-priced. */
export const MAX_REANCHOR_DRIFT_FRAC = 0.5;

/** Same rounding the drafters use when pricing rungs. */
const round = (x: number): number => Number(x.toFixed(6));

type ReanchorRungInput = Pick<LadderRung, 'id' | 'status' | 'triggerPx' | 'stopPx' | 'targetPx' | 'triggerMeta'>;

/**
 * Compute the re-anchored price patches for a draft's rungs. Scales triggerPx,
 * stopPx, targetPx and the price-valued triggerMeta fields (a numeric moveTo,
 * trailDistancePx, floorPx) by markPx/anchorPx. Non-price meta (minVolume,
 * fundingRate, indicatorValue = a stall COUNT, momentum flags) is untouched.
 * sizeCoins is untouched (risk-sized drafter rungs don't use it; the arm route
 * re-validates caps either way). Non-pending rungs are skipped.
 */
export function reanchorLadderRungs(rungs: ReanchorRungInput[], anchorPx: number, markPx: number): ReanchorOutcome {
  if (!Number.isFinite(anchorPx) || anchorPx <= 0) return { ok: false, reason: 'no usable stored anchor price' };
  if (!Number.isFinite(markPx) || markPx <= 0) return { ok: false, reason: 'no usable live mark' };
  const factor = markPx / anchorPx;
  if (Math.abs(factor - 1) > MAX_REANCHOR_DRIFT_FRAC) {
    return {
      ok: false,
      reason:
        `mark drifted ${((factor - 1) * 100).toFixed(1)}% from the draft anchor — beyond the ±${MAX_REANCHOR_DRIFT_FRAC * 100}% ` +
        `re-anchor bound. The draft premise is stale; re-draft instead of scaling.`,
    };
  }

  const scale = (v: number | null | undefined): number | null =>
    v != null && Number.isFinite(v) && v > 0 ? round(v * factor) : (v ?? null);

  const patches: ReanchorRungPatch[] = [];
  for (const r of rungs) {
    if (r.status !== 'pending') continue;
    let meta: RungTriggerMeta | null = r.triggerMeta ?? null;
    if (meta) {
      meta = { ...meta };
      if (typeof meta.moveTo === 'number') meta.moveTo = scale(meta.moveTo) ?? meta.moveTo;
      if (meta.trailDistancePx != null) meta.trailDistancePx = scale(meta.trailDistancePx) ?? meta.trailDistancePx;
      if (meta.floorPx != null) meta.floorPx = scale(meta.floorPx) ?? meta.floorPx;
    }
    patches.push({
      rungId: r.id,
      triggerPx: scale(r.triggerPx),
      stopPx: scale(r.stopPx),
      targetPx: scale(r.targetPx),
      triggerMeta: meta,
    });
  }
  if (patches.length === 0) return { ok: false, reason: 'no pending rungs to re-anchor' };
  return { ok: true, factor, patches };
}

/** The audit line appended to the thesis (the prose still quotes the OLD prices —
 *  this note is what tells a later reader those quoted numbers are pre-scale). */
export function reanchorThesisNote(anchorPx: number, markPx: number, nowIso: string): string {
  const pct = (markPx / anchorPx - 1) * 100;
  const signed = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  return `[re-anchored ${nowIso}: anchor ${round(anchorPx)} → ${round(markPx)} (${signed}) — every price level scaled by mark/anchor; prices quoted above are pre-scale, $ risk unchanged]`;
}

/** Remove earlier re-anchor notes so repeated re-anchors REPLACE the note instead of
 *  growing the thesis without bound (the per-event audit trail lives in analysis_log). */
export function stripReanchorNotes(thesis: string): string {
  return thesis.replace(/\s*\[re-anchored [^\]]*\]/g, '').trim();
}
