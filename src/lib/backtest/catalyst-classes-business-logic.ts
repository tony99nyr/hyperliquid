/** Catalyst-class move study, PURE. Pre-registration: docs/scout/PREREGISTRATION_catalyst-classes.md */

export const MIN_N = 15;
export const MEDIAN_BAR = 0.01;
export const CONTINUATION_BAR = 0.5;
export const HORIZONS_MS = { m15: 15 * 60_000, h2: 2 * 3_600_000, h24: 24 * 3_600_000 } as const;
export const REFERENCE_LEAD_MS = 30 * 60_000;
export const CONTROLS_PER_EVENT = 20;
const DAY_MS = 86_400_000;

export interface CloseCandle { closeTimeMs: number; close: number }
export type CloseMap = ReadonlyMap<number, number>;

export function closeMapOf(candles: ReadonlyArray<{ timestamp: number; close: number }>, intervalMs: number): Map<number, number> {
  return new Map(candles.map((c) => [c.timestamp + intervalMs, c.close]));
}

export interface EventMoves {
  atMs: number;
  /** Signed returns; m15 is null when the candle is missing. */
  m15: number | null;
  h2: number;
  h24: number;
  /** Actual elapsed minutes of the T+2h outcome from the reference (grid error check). */
  elapsedH2Min: number;
}

const floorTo = (ms: number, step: number): number => Math.floor(ms / step) * step;
const ceilTo = (ms: number, step: number): number => Math.ceil(ms / step) * step;

/** Reference at the largest grid boundary <= T-30m; outcome at the smallest boundary >= T+h. Null if T+2h or T+24h is missing. */
export function movesFor(atMs: number, intervalMs: number, closes: CloseMap): EventMoves | null {
  const refTime = floorTo(atMs - REFERENCE_LEAD_MS, intervalMs);
  const ref = closes.get(refTime);
  if (ref === undefined || ref <= 0) return null;
  const at = (h: number): number | null => {
    const px = closes.get(ceilTo(atMs + h, intervalMs));
    return px === undefined ? null : px / ref - 1;
  };
  const h2 = at(HORIZONS_MS.h2);
  const h24 = at(HORIZONS_MS.h24);
  if (h2 === null || h24 === null) return null;
  return { atMs, m15: at(HORIZONS_MS.m15), h2, h24, elapsedH2Min: (ceilTo(atMs + HORIZONS_MS.h2, intervalMs) - refTime) / 60_000 };
}

/** Linear-interpolated quantile, q in [0,1]. NaN for an empty list. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Same sign as the 2h move AND at least as large. A zero 2h move never continues. */
export function continues(h2: number, h24: number): boolean {
  return h2 !== 0 && Math.sign(h24) === Math.sign(h2) && Math.abs(h24) >= Math.abs(h2);
}

export interface ClassStats {
  n: number;
  medAbsM15: number; p80AbsM15: number; nM15: number;
  medAbsH2: number; p80AbsH2: number;
  medAbsH24: number; p80AbsH24: number;
  continuation: number;
}

export function statsOf(moves: readonly EventMoves[]): ClassStats {
  const abs = (pick: (m: EventMoves) => number | null): number[] =>
    moves.map(pick).filter((v): v is number => v !== null).map(Math.abs);
  const m15 = abs((m) => m.m15);
  const h2 = abs((m) => m.h2);
  const h24 = abs((m) => m.h24);
  return {
    n: moves.length,
    medAbsM15: quantile(m15, 0.5), p80AbsM15: quantile(m15, 0.8), nM15: m15.length,
    medAbsH2: quantile(h2, 0.5), p80AbsH2: quantile(h2, 0.8),
    medAbsH24: quantile(h24, 0.5), p80AbsH24: quantile(h24, 0.8),
    continuation: moves.length === 0 ? NaN : moves.filter((m) => continues(m.h2, m.h24)).length / moves.length,
  };
}

export type Verdict = 'JOIN' | 'REJECT' | 'INSUFFICIENT';

export function verdictOf(stats: ClassStats): Verdict {
  if (stats.n < MIN_N) return 'INSUFFICIENT';
  return stats.medAbsH2 > MEDIAN_BAR && stats.continuation > CONTINUATION_BAR ? 'JOIN' : 'REJECT';
}

/** mulberry32 seeded generator. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Control times for one event: same UTC weekday and time of day, inside [startMs, endMs],
 * not within 24h of any event of any class. Up to `count`, chosen by a seeded shuffle.
 */
export function controlTimes(atMs: number, startMs: number, endMs: number, allEventsMs: readonly number[],
  rng: () => number, count = CONTROLS_PER_EVENT): number[] {
  const tod = atMs % DAY_MS;
  const weekday = new Date(atMs).getUTCDay();
  const candidates: number[] = [];
  for (let day = Math.floor(startMs / DAY_MS) * DAY_MS; day <= endMs; day += DAY_MS) {
    const t = day + tod;
    if (t < startMs || t > endMs || new Date(t).getUTCDay() !== weekday) continue;
    if (allEventsMs.some((e) => Math.abs(e - t) < DAY_MS)) continue;
    candidates.push(t);
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, count);
}
