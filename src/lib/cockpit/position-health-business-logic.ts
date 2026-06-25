/**
 * PURE position-health logic for the trader position drill-down (fixture-tested).
 *
 * "Vet a position's health via chart" (Req D): the key copy-trading risk is
 * liquidation proximity — how far the current mark is from the leader's liq price,
 * as a fraction of the mark. We also pick the candle interval/window so the chart
 * spans from around the position's open to now without blowing HL's ~5000-bar cap.
 */

export type HealthStatus = 'healthy' | 'caution' | 'critical' | 'unknown';

export interface PositionHealth {
  status: HealthStatus;
  /** |mark − liq| as a % of mark (distance to liquidation). Null when inputs missing. */
  liqDistancePct: number | null;
}

/** Liq-distance thresholds (% of mark). */
export const LIQ_CRITICAL_PCT = 5;
export const LIQ_CAUTION_PCT = 15;

/** Derive the current mark from an HL position (positionValue = size × mark). */
export function markFromPosition(positionValue: number, size: number): number | null {
  if (!Number.isFinite(positionValue) || !Number.isFinite(size) || size <= 0) return null;
  return Math.abs(positionValue) / size;
}

export function computePositionHealth(input: {
  markPx: number | null;
  liquidationPx: number | null;
}): PositionHealth {
  const { markPx, liquidationPx } = input;
  if (markPx == null || markPx <= 0 || liquidationPx == null || liquidationPx <= 0) {
    return { status: 'unknown', liqDistancePct: null };
  }
  const liqDistancePct = (Math.abs(markPx - liquidationPx) / markPx) * 100;
  const status: HealthStatus =
    liqDistancePct < LIQ_CRITICAL_PCT ? 'critical' : liqDistancePct < LIQ_CAUTION_PCT ? 'caution' : 'healthy';
  return { status, liqDistancePct };
}

export type ChartInterval = '15m' | '1h' | '4h' | '1d';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Pick a now-anchored chart window + interval so it spans from ~the position's open
 * (openedAtMs, when known) to now with the entry bar inside, keeping the bar count
 * well under HL's ~5000-bar response cap. Falls back to a 7-day 1h window when the
 * open time is unknown (silent-baseline case — entry line still shows vs recent price).
 */
export function pickChartWindow(openedAtMs: number | null, now: number): { interval: ChartInterval; lookbackMs: number } {
  const ageMs = openedAtMs != null && openedAtMs > 0 && openedAtMs < now ? now - openedAtMs : null;
  if (ageMs == null) return { interval: '1h', lookbackMs: 7 * DAY };
  const pad = ageMs * 0.25 + DAY; // include some pre-entry context
  const span = ageMs + pad;
  if (ageMs > 45 * DAY) return { interval: '1d', lookbackMs: span };
  if (ageMs > 5 * DAY) return { interval: '4h', lookbackMs: span };
  if (ageMs > 36 * HOUR) return { interval: '1h', lookbackMs: span };
  return { interval: '15m', lookbackMs: Math.max(span, 12 * HOUR) };
}
