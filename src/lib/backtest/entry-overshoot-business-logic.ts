/** Entry overshoot in bps and nominal R, PURE. Pre-registration: docs/scout/PREREGISTRATION_catalyst-classes.md (Part B) */
import { quantile } from './catalyst-classes-business-logic';

export const BUILD_BAR_R = 0.2;
export const MIN_EVENT_LEGS = 5;

export interface OvershootInput {
  side: 'long' | 'short';
  triggerPx: number;
  fillPx: number;
  stopPx: number | null;
  stopFrac: number | null;
}

export interface Overshoot { bps: number; r: number }

/** Adverse distance is fill-trigger for a long and trigger-fill for a short. Negative = price improvement. */
export function overshootOf(input: OvershootInput): Overshoot | null {
  const { side, triggerPx, fillPx, stopPx, stopFrac } = input;
  if (![triggerPx, fillPx].every((v) => Number.isFinite(v) && v > 0)) return null;
  const stopDist = stopPx !== null && Number.isFinite(stopPx) && stopPx > 0
    ? Math.abs(triggerPx - stopPx)
    : stopFrac !== null && Number.isFinite(stopFrac) && stopFrac > 0 ? triggerPx * stopFrac : NaN;
  if (!Number.isFinite(stopDist) || stopDist <= 0) return null;
  const adverse = side === 'long' ? fillPx - triggerPx : triggerPx - fillPx;
  return { bps: (adverse / triggerPx) * 10_000, r: adverse / stopDist };
}

export interface OvershootSummary {
  n: number; meanBps: number; medianBps: number; p80Bps: number;
  meanR: number; medianR: number; p80R: number; meanRClipped: number;
}

export function summariseOvershoot(rows: readonly Overshoot[]): OvershootSummary {
  const bps = rows.map((r) => r.bps);
  const rr = rows.map((r) => r.r);
  const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
  return {
    n: rows.length, meanBps: mean(bps), medianBps: quantile(bps, 0.5), p80Bps: quantile(bps, 0.8),
    meanR: mean(rr), medianR: quantile(rr, 0.5), p80R: quantile(rr, 0.8), meanRClipped: mean(rr.map((v) => Math.max(0, v))),
  };
}

export type BuildVerdict = 'BUILD' | 'DO-NOT-BUILD' | 'INSUFFICIENT';

export function buildVerdict(eventLegs: OvershootSummary): BuildVerdict {
  if (eventLegs.n < MIN_EVENT_LEGS) return 'INSUFFICIENT';
  return eventLegs.meanR > BUILD_BAR_R ? 'BUILD' : 'DO-NOT-BUILD';
}
