/**
 * PURE replay of the frozen event-straddle rule on candles around a scheduled print.
 * Used by the `hip3-earnings-straddle` study. See docs/scout/PREREGISTRATION_hip3-earnings-straddle.md.
 */
export interface StudyCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ReplayConfig {
  /** Candle length in ms (1h or 15m). */
  intervalMs: number;
  /** Reference candle must end at or before print minus this lead. */
  leadMs: number;
  /** Gate distance from the reference, as a fraction (0.01 = 1%). */
  gatePct: number;
  /** Taker fee per side as a fraction (0.0009 = 9 bps). */
  feeRate: number;
  /** Minimum share of expected candles that must exist in the window. */
  minCoverage: number;
}

export const FROZEN_CONFIG_1H: ReplayConfig = {
  intervalMs: 3_600_000, leadMs: 0, gatePct: 0.01, feeRate: 0.0009, minCoverage: 0.8,
};

export type EventState = 'ineligible' | 'no-fill' | 'filled';

export interface EventResult {
  state: EventState;
  /** Nominal R. 0 for no-fill. null for ineligible. */
  r: number | null;
  reason?: string;
  side?: 'long' | 'short';
  reference?: number;
  gate?: number;
  entry?: number;
  /** Close minus gate in R units, always at least 0 on the filled side. */
  overshootR?: number;
  exitReason?: 'stop' | 'time';
  maxFavourableR?: number;
}

const HOUR = 3_600_000;
const WINDOW_MS = 24 * HOUR;

/** Index of the last candle that ends at or before `limit`, or -1. */
export function referenceIndex(candles: StudyCandle[], limit: number, intervalMs: number): number {
  let found = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].timestamp + intervalMs <= limit) found = i;
    else break;
  }
  return found;
}

function valid(bar: StudyCandle): boolean {
  return [bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v) && v > 0) &&
    bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close);
}

export function replayStraddleEvent(input: StudyCandle[], printAt: number, config: ReplayConfig): EventResult {
  const candles = [...input].sort((a, b) => a.timestamp - b.timestamp);
  const ineligible = (reason: string): EventResult => ({ state: 'ineligible', r: null, reason });
  const refIdx = referenceIndex(candles, printAt - config.leadMs, config.intervalMs);
  if (refIdx < 0) return ineligible('no reference candle');
  const startTs = candles[refIdx].timestamp + config.intervalMs;
  const expiry = printAt + WINDOW_MS;
  const bars = candles.slice(refIdx + 1);
  if (bars.some((bar) => !valid(bar))) return ineligible('invalid candle');
  const inWindow = bars.filter((bar) => bar.timestamp >= startTs && bar.timestamp < expiry).length;
  const expected = Math.ceil((expiry - startTs) / config.intervalMs);
  if (inWindow < expected * config.minCoverage) return ineligible(`coverage ${inWindow}/${expected}`);
  if (!bars.some((bar) => bar.timestamp >= expiry)) return ineligible('no candle at or after expiry');

  const reference = candles[refIdx].close;
  const longGate = reference * (1 + config.gatePct);
  const shortGate = reference * (1 - config.gatePct);
  let fillIdx = -1;
  let side: 'long' | 'short' = 'long';
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.timestamp < startTs) continue;
    if (bar.timestamp >= expiry) break;
    const isLong = bar.close >= longGate;
    const isShort = bar.close <= shortGate;
    if (isLong === isShort) continue;
    fillIdx = i;
    side = isLong ? 'long' : 'short';
    break;
  }
  if (fillIdx < 0) return { state: 'no-fill', r: 0, reference };

  const dir = side === 'long' ? 1 : -1;
  const gate = side === 'long' ? longGate : shortGate;
  const distance = Math.abs(gate - reference);
  const entry = bars[fillIdx].close;
  const level = (k: number): number => gate + dir * distance * k;
  const trailDistance = distance * 0.8;
  let stop = reference;
  let remaining = 1;
  let pnl = -entry * config.feeRate;
  let trailing = false;
  let beDone = false;
  let firstDone = false;
  let secondDone = false;
  let maxFav = 0;
  const pending: Array<'breakeven' | 'first' | 'second' | 'trail'> = [];
  const reduce = (fraction: number, price: number): void => {
    const quantity = remaining * fraction;
    pnl += quantity * (dir * (price - entry) - price * config.feeRate);
    remaining -= quantity;
  };
  const done = (reason: 'stop' | 'time'): EventResult => ({
    state: 'filled', r: pnl / distance, side, reference, gate, entry, exitReason: reason,
    overshootR: Math.max(0, dir * (entry - gate)) / distance, maxFavourableR: maxFav,
  });

  for (let i = fillIdx + 1; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.timestamp >= expiry) {
      reduce(1, bar.open);
      return done('time');
    }
    const through = dir === 1 ? bar.low <= stop : bar.high >= stop;
    if (through) {
      reduce(1, dir === 1 ? Math.min(bar.open, stop) : Math.max(bar.open, stop));
      return done('stop');
    }
    for (const action of pending) {
      if (action === 'breakeven' && dir * (entry - stop) > 0) stop = entry;
      if (action === 'first') reduce(0.34, bar.open);
      if (action === 'second') reduce(0.5, bar.open);
      if (action === 'trail') trailing = true;
    }
    pending.length = 0;
    maxFav = Math.max(maxFav, (dir * ((dir === 1 ? bar.high : bar.low) - entry)) / distance);
    const reached = (price: number): boolean => dir * (bar.close - price) >= 0;
    if (!beDone && reached(level(0.7))) { pending.push('breakeven'); beDone = true; }
    if (!firstDone && reached(level(1))) { pending.push('first'); firstDone = true; }
    if (!secondDone && reached(level(2))) { pending.push('second'); secondDone = true; }
    if (!trailing && reached(level(1.2))) pending.push('trail');
    if (trailing) {
      const candidate = bar.close - dir * trailDistance;
      if (dir * (candidate - stop) > 0) stop = candidate;
    }
  }
  return ineligible('ran out of candles with an open position');
}

export type Verdict = 'PASS' | 'FAIL' | 'INSUFFICIENT';

export interface StudySummary {
  n: number;
  filled: number;
  noFill: number;
  meanR: number | null;
  meanRFilled: number | null;
  winRate: number | null;
  meanRExTop3: number | null;
  ci95: [number, number] | null;
  verdict: Verdict;
  checks: { mean: boolean; n: boolean; exTop3: boolean };
}

export const BAR = { minMeanR: 0.2, minEvents: 30, removeTop: 3 } as const;

const mean = (values: number[]): number | null =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/** Deterministic percentile bootstrap of the mean. */
export function bootstrapCi(values: number[], rounds = 10_000): [number, number] | null {
  if (!values.length) return null;
  let seed = 0x5eed1234;
  const means: number[] = [];
  for (let round = 0; round < rounds; round++) {
    let sum = 0;
    for (let draw = 0; draw < values.length; draw++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      sum += values[seed % values.length];
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(rounds * 0.025)], means[Math.floor(rounds * 0.975) - 1]];
}

/** Summarise eligible event R values (no-fills already 0) against the pre-registered bar. */
export function summarise(results: EventResult[]): StudySummary {
  const eligible = results.filter((result) => result.state !== 'ineligible' && result.r !== null);
  const rs = eligible.map((result) => result.r as number);
  const filledRs = eligible.filter((result) => result.state === 'filled').map((result) => result.r as number);
  const sortedDesc = [...rs].sort((a, b) => b - a);
  const exTop3 = sortedDesc.slice(BAR.removeTop);
  const meanR = mean(rs);
  const meanRExTop3 = mean(exTop3);
  const checks = {
    mean: meanR !== null && meanR >= BAR.minMeanR,
    n: rs.length >= BAR.minEvents,
    exTop3: meanRExTop3 !== null && meanRExTop3 > 0,
  };
  const verdict: Verdict = !checks.n ? 'INSUFFICIENT' : checks.mean && checks.exTop3 ? 'PASS' : 'FAIL';
  return {
    n: rs.length, filled: filledRs.length, noFill: rs.length - filledRs.length,
    meanR, meanRFilled: mean(filledRs),
    winRate: filledRs.length ? filledRs.filter((r) => r > 0).length / filledRs.length : null,
    meanRExTop3, ci95: bootstrapCi(rs), verdict, checks,
  };
}
