/**
 * PURE spot-perp carry replay. No I/O. See docs/scout/PREREGISTRATION_spot-perp-carry.md.
 *
 * Position: long spot, short the same quantity of perp. Delta-neutral. The return is
 * funding earned, minus fees, plus the basis change (spot minus perp price).
 * Unlike src/lib/scout/funding-carry-business-logic.ts, the position can exit on a
 * funding flip and re-enter later, as often as the signal allows.
 */

const HOUR_MS = 3_600_000;
const HOURS_PER_YEAR = 8760;

export interface FundingRow { time: number; fundingHourly: number }
export interface CarryCandle { timestamp: number; open: number; high: number; low: number; close: number }

export interface CarryParams {
  /** Enter when the trailing mean hourly funding is above this. */
  enterAbove: number;
  /** Exit when the trailing mean hourly funding is below this (a negative number). */
  exitBelow: number;
  windowHours: number;
  spotTakerFrac: number;
  perpTakerFrac: number;
  perpLeverage: number;
  /** Candle step in ms. Fills happen only at candle opens. */
  stepMs: number;
  /** false = hold from the first possible hour with no exit (reference only). */
  useSignal: boolean;
}

export const PREREGISTERED_PARAMS: CarryParams = {
  enterAbove: 0.00001,
  exitBelow: -0.000005,
  windowHours: 24,
  spotTakerFrac: 0.0007,
  perpTakerFrac: 0.00045,
  perpLeverage: 3,
  stepMs: HOUR_MS,
  useSignal: true,
};

export interface CarryTrade {
  entryTime: number;
  exitTime: number | null;
  entrySpot: number;
  entryPerp: number;
  exitSpot: number | null;
  exitPerp: number | null;
  /** Largest perp high above the entry perp price while held, as a fraction. */
  maxRally: number;
  fundingEarned: number;
  feesPaid: number;
  basisPnl: number;
}

export interface CarryRun {
  times: number[];
  /** Cumulative mark-to-market net P&L as a fraction of capital, per hour. */
  equity: number[];
  trades: CarryTrade[];
  hoursInMarket: number;
  capitalPerNotional: number;
  deferredEntries: number;
}

function floorTo(t: number, step: number): number { return Math.floor(t / step) * step; }

function byStep(candles: CarryCandle[], step: number): Map<number, CarryCandle> {
  return new Map(candles.filter((c) => [c.open, c.high].every(Number.isFinite) && c.open > 0)
    .map((c) => [floorTo(c.timestamp, step), c]));
}

/** Replay one coin. `maxLeverage`-based margin is reported separately by marginForRally. */
export function replaySpotPerpCarry(
  funding: FundingRow[], spotCandles: CarryCandle[], perpCandles: CarryCandle[],
  params: CarryParams = PREREGISTERED_PARAMS,
): CarryRun {
  const step = params.stepMs;
  const spot = byStep(spotCandles, step);
  const perp = byStep(perpCandles, step);
  const capitalPerNotional = 1 + 1 / params.perpLeverage;
  const empty: CarryRun = { times: [], equity: [], trades: [], hoursInMarket: 0, capitalPerNotional, deferredEntries: 0 };
  if (!spot.size || !perp.size) return empty;
  const spotStart = Math.min(...spot.keys());
  const rows = funding
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.fundingHourly))
    .map((p) => ({ time: floorTo(p.time + HOUR_MS / 2, HOUR_MS), fundingHourly: p.fundingHourly }))
    .sort((a, b) => a.time - b.time);
  const first = rows.findIndex((r) => r.time >= spotStart + (params.windowHours - 1) * HOUR_MS);
  if (first < 0) return empty;

  const times: number[] = [];
  const equity: number[] = [];
  const trades: CarryTrade[] = [];
  let open: CarryTrade | null = null;
  let qty = 0;
  let realised = 0;
  let cumFunding = 0;
  let cumFees = 0;
  let pending: 'enter' | 'exit' | null = params.useSignal ? null : 'enter';
  let lastSpot = NaN;
  let lastPerp = NaN;
  let hoursInMarket = 0;
  let deferred = 0;

  for (let i = first; i < rows.length; i++) {
    const t = rows[i].time;
    const sc = spot.get(floorTo(t, step));
    const pc = perp.get(floorTo(t, step));
    if (sc) lastSpot = sc.open;
    if (pc) lastPerp = pc.open;
    const atOpen = t % step === 0; // a fill needs a fresh candle open on both legs

    if (pending === 'enter' && !open) {
      if (sc && pc && atOpen) {
        qty = 1 / sc.open;
        const fee = 1 * params.spotTakerFrac + qty * pc.open * params.perpTakerFrac;
        open = { entryTime: t, exitTime: null, entrySpot: sc.open, entryPerp: pc.open, exitSpot: null, exitPerp: null,
          maxRally: 0, fundingEarned: 0, feesPaid: fee, basisPnl: 0 };
        cumFees += fee;
        trades.push(open);
        pending = null;
      } else deferred++;
    } else if (pending === 'exit' && open && sc && pc && atOpen) {
      const fee = qty * sc.open * params.spotTakerFrac + qty * pc.open * params.perpTakerFrac;
      const basis = qty * ((sc.open - open.entrySpot) - (pc.open - open.entryPerp));
      open.exitTime = t; open.exitSpot = sc.open; open.exitPerp = pc.open;
      open.feesPaid += fee; open.basisPnl = basis;
      cumFees += fee; realised += basis;
      open = null; pending = null;
    }

    let mtm = 0;
    if (open && Number.isFinite(lastSpot) && Number.isFinite(lastPerp)) {
      const earned = rows[i].fundingHourly * qty * lastPerp; // short earns positive funding
      cumFunding += earned;
      open.fundingEarned += earned;
      mtm = qty * ((lastSpot - open.entrySpot) - (lastPerp - open.entryPerp));
      open.basisPnl = mtm;
      if (pc && atOpen) open.maxRally = Math.max(open.maxRally, pc.high / open.entryPerp - 1);
      hoursInMarket++;
    }
    times.push(t);
    equity.push((realised + mtm + cumFunding - cumFees) / capitalPerNotional);

    if (params.useSignal) {
      const from = i - params.windowHours + 1;
      if (from >= 0) {
        let sum = 0;
        for (let j = from; j <= i; j++) sum += rows[j].fundingHourly;
        const mean = sum / params.windowHours;
        if (!open && mean > params.enterAbove) pending = 'enter';
        else if (open && mean < params.exitBelow) pending = 'exit';
        else pending = null;
      }
    }
  }

  // Charge a hypothetical exit on the last bar so an open trade is not flattered.
  if (open && equity.length && Number.isFinite(lastSpot) && Number.isFinite(lastPerp)) {
    const fee = qty * lastSpot * params.spotTakerFrac + qty * lastPerp * params.perpTakerFrac;
    equity[equity.length - 1] -= fee / capitalPerNotional;
    open.feesPaid += fee;
  }
  return { times, equity, trades, hoursInMarket, capitalPerNotional, deferredEntries: deferred };
}

export interface MarginNeed {
  rally: number;
  /** Perp account equity left after the rally, per 1 of spot notional. */
  equityLeft: number;
  /** Top-up that restores the starting leverage. */
  topUpToLeverage: number;
  /** Top-up that keeps equity at or above maintenance margin. */
  topUpToMaintenance: number;
  /** Rally at which an isolated short at this leverage is liquidated, no top-up. */
  liquidationRally: number;
}

/** Margin need of the short leg after a rally. maintenanceFrac = 1 / (2 x maxLeverage) on HL. */
export function marginForRally(rally: number, leverage: number, maintenanceFrac: number): MarginNeed {
  const equityLeft = 1 / leverage - rally;
  const notional = 1 + rally;
  return {
    rally,
    equityLeft,
    topUpToLeverage: Math.max(0, notional / leverage - equityLeft),
    topUpToMaintenance: Math.max(0, notional * maintenanceFrac - equityLeft),
    liquidationRally: (1 / leverage - maintenanceFrac) / (1 + maintenanceFrac),
  };
}

export interface CarryMetrics {
  hours: number;
  days: number;
  netApr: number;
  totalReturn: number;
  yearPnl: Array<{ year: number; days: number; pnl: number; counted: boolean }>;
  yearsWithData: number;
  yearsPositive: number;
  worst30d: number | null;
  timeInMarket: number;
  roundTrips: number;
}

const MIN_YEAR_DAYS = 60;
const WINDOW_30D_HOURS = 720;

export function summariseCarry(times: number[], equity: number[], hoursInMarket = NaN, roundTrips = 0): CarryMetrics {
  const hours = times.length;
  const years = new Map<number, { days: number; start: number; end: number }>();
  for (let i = 0; i < hours; i++) {
    const y = new Date(times[i]).getUTCFullYear();
    const before = i === 0 ? 0 : equity[i - 1];
    const slot = years.get(y) ?? { days: 0, start: before, end: equity[i] };
    slot.days += 1 / 24;
    slot.end = equity[i];
    years.set(y, slot);
  }
  const yearPnl = [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, s]) => ({
    year, days: s.days, pnl: s.end - s.start, counted: s.days >= MIN_YEAR_DAYS,
  }));
  const counted = yearPnl.filter((y) => y.counted);
  let worst: number | null = null;
  for (let i = WINDOW_30D_HOURS; i < hours; i++) {
    const d = equity[i] - equity[i - WINDOW_30D_HOURS];
    if (worst === null || d < worst) worst = d;
  }
  const total = hours ? equity[hours - 1] : 0;
  return {
    hours, days: hours / 24,
    netApr: hours ? total / (hours / HOURS_PER_YEAR) : 0,
    totalReturn: total,
    yearPnl,
    yearsWithData: counted.length,
    yearsPositive: counted.filter((y) => y.pnl > 0).length,
    worst30d: worst,
    timeInMarket: hours && Number.isFinite(hoursInMarket) ? hoursInMarket / hours : NaN,
    roundTrips,
  };
}

/** Equal-weight basket of equity curves: each hour averages the increments of the coins live that hour. */
export function basketEquity(runs: Array<Pick<CarryRun, 'times' | 'equity'>>): { times: number[]; equity: number[] } {
  const inc = new Map<number, number[]>();
  for (const r of runs) {
    r.times.forEach((t, i) => {
      const d = r.equity[i] - (i === 0 ? 0 : r.equity[i - 1]);
      const list = inc.get(t) ?? [];
      list.push(d);
      inc.set(t, list);
    });
  }
  const times = [...inc.keys()].sort((a, b) => a - b);
  let cum = 0;
  const equity = times.map((t) => {
    const list = inc.get(t) ?? [];
    cum += list.reduce((a, b) => a + b, 0) / list.length;
    return cum;
  });
  return { times, equity };
}

export const BAR = { minApr: 0.06, minPositiveYears: 3, minWorst30d: -0.01, minDays: 365, minYears: 3 } as const;

export type Verdict = 'PASS' | 'FAIL' | 'INSUFFICIENT';
export interface VerdictResult { verdict: Verdict; reasons: string[] }

/** Pre-registered verdict. FAIL on any measurable failure; INSUFFICIENT if data cannot test the year bar. */
export function carryVerdict(m: CarryMetrics): VerdictResult {
  const reasons: string[] = [];
  let failed = false;
  if (m.netApr < BAR.minApr) { failed = true; reasons.push(`net APR ${(m.netApr * 100).toFixed(2)}% < 6%`); }
  if (m.worst30d !== null && m.worst30d <= BAR.minWorst30d) {
    failed = true; reasons.push(`worst 30d ${(m.worst30d * 100).toFixed(2)}% <= -1%`);
  }
  const needed = m.yearsWithData >= 4 ? 3 : m.yearsWithData === 3 ? 3 : null;
  if (needed !== null && m.yearsPositive < needed) {
    failed = true; reasons.push(`positive years ${m.yearsPositive}/${m.yearsWithData} < ${needed}`);
  }
  if (failed) return { verdict: 'FAIL', reasons };
  if (needed === null) reasons.push(`only ${m.yearsWithData} calendar year(s) with data`);
  if (m.days < BAR.minDays) reasons.push(`only ${m.days.toFixed(0)} days of data`);
  if (m.worst30d === null) reasons.push('under 30 days of data');
  return reasons.length ? { verdict: 'INSUFFICIENT', reasons } : { verdict: 'PASS', reasons: ['all three tests pass'] };
}
