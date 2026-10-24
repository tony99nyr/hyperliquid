/** Pure, conservative candle replay of the registered event-straddle exits. */
export interface ShadowCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ShadowPolicy = 'template' | '48h' | 'trail-only' | 'no-1r';

export interface ShadowInput {
  side: 'long' | 'short';
  gate: number;
  stop: number;
  printAt: number;
  /** Timestamp of the first candle after the completed trigger candle. */
  entryAt: number;
  candles: ShadowCandle[];
  levels?: { breakeven: number; first: number; second: number; trail: number; trailDistance: number };
  /** Times of actual filled momentum-stall reduce fires, if available. */
  stallAt?: number[];
}

export interface ShadowResult {
  state: 'closed' | 'open' | 'unavailable';
  /** Realised plus marked R when open. Open values are provisional. */
  r: number | null;
  remaining: number;
  restingStop: number;
  expired: boolean;
  stopFill: number | null;
  stallObserved: boolean;
}

const HOUR = 3_600_000;
const FEE = 0.00045;
const ENTRY_OVERSHOOT = 0.0016;

function validCandles(candles: ShadowCandle[]): boolean {
  return candles.every((bar) => Number.isFinite(bar.timestamp) && bar.open > 0 &&
    bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close));
}

/** First completed close through either OCO gate. Ties and missing next bars do not count. */
export function firstTrigger(
  candles: ShadowCandle[], printAt: number, longGate: number, shortGate: number,
): { side: 'long' | 'short'; entryAt: number } | null {
  for (let i = 0; i + 1 < candles.length; i++) {
    const bar = candles[i];
    if (bar.timestamp < printAt - 15 * 60_000 || bar.timestamp >= printAt + 24 * HOUR) continue;
    const long = bar.close >= longGate;
    const short = bar.close <= shortGate;
    if (long === short) continue;
    return { side: long ? 'long' : 'short', entryAt: candles[i + 1].timestamp };
  }
  return null;
}

export function simulateStraddleExit(input: ShadowInput, policy: ShadowPolicy): ShadowResult {
  const direction = input.side === 'long' ? 1 : -1;
  const distance = direction * (input.gate - input.stop);
  const bars = [...input.candles].sort((a, b) => a.timestamp - b.timestamp);
  const empty: ShadowResult = { state: 'unavailable', r: null, remaining: 0,
    restingStop: input.stop, expired: false, stopFill: null, stallObserved: false };
  if (!(distance > 0) || !validCandles(bars)) return empty;
  const start = bars.findIndex((bar) => bar.timestamp >= input.entryAt);
  if (start < 0) return empty;
  const expiry = input.printAt + (policy === '48h' ? 48 : 24) * HOUR;
  const level = input.levels ?? {
    breakeven: input.gate + direction * distance * 0.7,
    first: input.gate + direction * distance,
    second: input.gate + direction * distance * 2,
    trail: input.gate + direction * distance * 1.2,
    trailDistance: distance * 0.8,
  };
  const entryBar = bars[start];
  const entry = (direction === 1 ? Math.max(entryBar.open, input.gate) : Math.min(entryBar.open, input.gate))
    + direction * input.gate * ENTRY_OVERSHOOT;
  let stop = input.stop;
  let remaining = 1;
  let pnl = -entry * FEE;
  let trail = false;
  let breakevenDone = false;
  let firstBankDone = false;
  let secondBankDone = false;
  let expired = false;
  let stopFill: number | null = null;
  let stallObserved = false;
  const pending: Array<'breakeven' | 'first' | 'second' | 'trail' | 'stall'> = [];
  const stallTimes = new Set(input.stallAt ?? []);
  const tighten = (candidate: number): void => {
    if (direction * (candidate - stop) > 0) stop = candidate;
  };
  const reduce = (fraction: number, price: number): void => {
    const quantity = remaining * fraction;
    pnl += quantity * (direction * (price - entry) - price * FEE);
    remaining -= quantity;
  };

  for (let i = start; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.timestamp >= expiry) {
      expired = true;
      pending.length = 0;
    }
    // The exchange-resting stop acts before watcher rungs. A gap gets its open.
    const throughStop = direction === 1 ? bar.low <= stop : bar.high >= stop;
    if (throughStop) {
      stopFill = direction === 1 ? Math.min(bar.open, stop) : Math.max(bar.open, stop);
      reduce(1, stopFill);
      return { state: 'closed', r: pnl / distance, remaining: 0, restingStop: stop,
        expired, stopFill, stallObserved };
    }
    if (!expired) {
      for (const action of pending) {
        if (action === 'breakeven') tighten(entry);
        if (action === 'first') reduce(0.34, bar.open);
        if (action === 'second') reduce(0.5, bar.open);
        if (action === 'trail') trail = true;
        if (action === 'stall') { reduce(0.5, bar.open); stallObserved = true; }
      }
      pending.length = 0;
      if (remaining <= 1e-10) return { state: 'closed', r: pnl / distance, remaining: 0,
        restingStop: stop, expired, stopFill, stallObserved };
      const reached = (price: number): boolean => direction * (bar.close - price) >= 0;
      if (!breakevenDone && reached(level.breakeven)) { pending.push('breakeven'); breakevenDone = true; }
      if (policy !== 'trail-only' && policy !== 'no-1r' && !firstBankDone && reached(level.first)) {
        pending.push('first'); firstBankDone = true;
      }
      if (policy !== 'trail-only' && !secondBankDone && reached(level.second)) {
        pending.push('second'); secondBankDone = true;
      }
      if (!trail && reached(level.trail)) pending.push('trail');
      if (stallTimes.has(bar.timestamp)) pending.push('stall');
      if (trail) tighten(bar.close - direction * level.trailDistance);
    }
  }
  const mark = bars[bars.length - 1].close;
  return { state: 'open', r: (pnl + remaining * direction * (mark - entry)) / distance,
    remaining, restingStop: stop, expired, stopFill, stallObserved };
}

export interface PairedReturn { event: string; template: number; variant: number }
export interface PairedSummary {
  n: number;
  meanDifference: number | null;
  ci95: [number, number] | null;
  worstDifference: number | null;
  adopt: boolean;
}

/** Event-level percentile bootstrap, deterministic for repeatable desk reports. */
export function pairedSummary(pairs: PairedReturn[]): PairedSummary {
  const unique = new Map(pairs.map((pair) => [pair.event, pair]));
  if (unique.size !== pairs.length) throw new Error('duplicate event in paired sample');
  const differences = pairs.map((pair) => pair.variant - pair.template);
  const n = differences.length;
  if (!n) return { n, meanDifference: null, ci95: null, worstDifference: null, adopt: false };
  const meanDifference = differences.reduce((sum, value) => sum + value, 0) / n;
  let seed = 0x5eed1234;
  const samples: number[] = [];
  for (let round = 0; round < 10_000; round++) {
    let sum = 0;
    for (let draw = 0; draw < n; draw++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      sum += differences[seed % n];
    }
    samples.push(sum / n);
  }
  samples.sort((a, b) => a - b);
  const ci95: [number, number] = [samples[249], samples[9749]];
  const worstDifference = Math.min(...differences);
  return { n, meanDifference, ci95, worstDifference,
    adopt: n >= 8 && ci95[0] > 0 && worstDifference >= -1 };
}
