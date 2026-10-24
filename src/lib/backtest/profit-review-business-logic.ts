/**
 * PURE logic for the profit-review evidence bundle (docs/PROFIT_REVIEW_2026-10-24.md, item 0).
 * No I/O: fixture-tested in tests/lib/backtest/profit-review.test.ts. The script
 * scripts/analysis/profit-review/profit-review.ts feeds it HL userFills / userFunding and
 * Supabase SELECT rows.
 */

export interface HlFillRow {
  coin: string;
  px: string;
  sz: string;
  side: string; // 'B' | 'A'
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  fee: string;
  tid?: number;
}

export interface FundingRow {
  time: number;
  delta: { coin: string; usdc: string };
}

export interface RoundTrip {
  coin: string;
  side: 'long' | 'short';
  t0: number;
  t1: number;
  fillCount: number;
  pnl: number; // sum closedPnl (gross of fees)
  fee: number;
  funding: number;
  net: number; // pnl - fee + funding
  entryAvg: number;
  exitAvg: number;
  maxSz: number;
  hours: number;
  /** True when the first fill already had a non-zero startPosition (history truncated). */
  inherited: boolean;
  ladderId: string | null;
  setup: string;
  otherLadderIds: string[];
}

/** Spot fills ('@107', 'PURR/USDC') and non-position dirs are not perp round trips. */
export function isPerpFill(f: HlFillRow): boolean {
  if (f.coin.startsWith('@') || f.coin.includes('/')) return false;
  return /^(Open|Close|Long|Short)/.test(f.dir);
}

const EPS = 1e-9;

/** Flat-to-flat round trips per coin, net of fees and funding paid while the position was open. */
export function buildRoundTrips(
  allFills: HlFillRow[],
  funding: FundingRow[],
): { trips: RoundTrip[]; open: { coin: string; since: number }[]; excludedFills: number } {
  const fills = allFills.filter(isPerpFill).sort((a, b) => a.time - b.time);
  const excludedFills = allFills.length - fills.length;
  const trips: RoundTrip[] = [];
  const cur = new Map<string, { fills: HlFillRow[]; side: 'long' | 'short'; inherited: boolean }>();
  for (const f of fills) {
    const sz = Number(f.sz);
    const signed = f.side === 'B' ? sz : -sz;
    const start = Number(f.startPosition);
    let t = cur.get(f.coin);
    if (!t) {
      t = { fills: [], side: start + signed > 0 ? 'long' : 'short', inherited: Math.abs(start) > EPS };
      cur.set(f.coin, t);
    }
    t.fills.push(f);
    if (Math.abs(start + signed) < EPS) {
      trips.push(finaliseTrip(f.coin, t, funding));
      cur.delete(f.coin);
    }
  }
  const open = [...cur.entries()].map(([coin, t]) => ({ coin, since: t.fills[0].time }));
  return { trips, open, excludedFills };
}

function finaliseTrip(
  coin: string,
  t: { fills: HlFillRow[]; side: 'long' | 'short'; inherited: boolean },
  funding: FundingRow[],
): RoundTrip {
  const t0 = t.fills[0].time;
  const t1 = t.fills[t.fills.length - 1].time;
  const pnl = t.fills.reduce((s, f) => s + Number(f.closedPnl), 0);
  const fee = t.fills.reduce((s, f) => s + Number(f.fee), 0);
  const fund = funding
    .filter((x) => x.delta.coin === coin && x.time >= t0 && x.time <= t1)
    .reduce((s, x) => s + Number(x.delta.usdc), 0);
  const opens = t.fills.filter((f) => f.dir.startsWith('Open'));
  const closes = t.fills.filter((f) => !f.dir.startsWith('Open'));
  const wavg = (xs: HlFillRow[]): number => {
    const sz = xs.reduce((s, f) => s + Number(f.sz), 0);
    return sz > 0 ? xs.reduce((s, f) => s + Number(f.px) * Number(f.sz), 0) / sz : 0;
  };
  return {
    coin,
    side: t.side,
    t0,
    t1,
    fillCount: t.fills.length,
    pnl,
    fee,
    funding: fund,
    net: pnl - fee + fund,
    entryAvg: wavg(opens),
    exitAvg: wavg(closes),
    maxSz: opens.reduce((s, f) => s + Number(f.sz), 0),
    hours: (t1 - t0) / 3.6e6,
    inherited: t.inherited,
    ladderId: null,
    setup: 'manual/other',
    otherLadderIds: [],
  };
}

export interface Stats {
  n: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  payoff: number;
  expectancy: number;
  net: number;
  fees: number;
  funding: number;
}

export function summarise(trips: RoundTrip[]): Stats {
  const w = trips.filter((t) => t.net > 0);
  const l = trips.filter((t) => t.net <= 0);
  const sum = (xs: RoundTrip[], k: 'net' | 'fee' | 'funding'): number => xs.reduce((s, t) => s + t[k], 0);
  const avgWin = w.length ? sum(w, 'net') / w.length : 0;
  const avgLoss = l.length ? sum(l, 'net') / l.length : 0;
  return {
    n: trips.length,
    winRate: trips.length ? w.length / trips.length : 0,
    avgWin,
    avgLoss,
    payoff: avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : 0,
    expectancy: trips.length ? sum(trips, 'net') / trips.length : 0,
    net: sum(trips, 'net'),
    fees: sum(trips, 'fee'),
    funding: sum(trips, 'funding'),
  };
}

export function groupStats(trips: RoundTrip[], key: (t: RoundTrip) => string): Record<string, Stats> {
  const g = new Map<string, RoundTrip[]>();
  for (const t of trips) {
    const k = key(t);
    g.set(k, [...(g.get(k) ?? []), t]);
  }
  return Object.fromEntries([...g.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, summarise(v)]));
}

export const monthKey = (t: RoundTrip): string => new Date(t.t0).toISOString().slice(0, 7);

// ---------------------------------------------------------------- ladder join

export interface RungRow {
  id: string;
  ladder_id: string;
  coin: string;
  action: string;
  trigger_kind: string;
  trigger_px: number | null;
  risk_usd: number | null;
}
export interface FireRow {
  id: string;
  ladder_id: string;
  rung_id: string;
  status: string;
  fired_at: string;
}
export interface OutcomeRow {
  ladder_id: string;
  title: string;
  coin: string;
  side: string;
  setup_type: string;
  planned_risk_usd: number | null;
  realized_pnl_usd: number | null;
  fees_usd: number | null;
  realized_r: number | null;
  outcome: string;
  window_start: string | null;
  window_end: string | null;
}

/**
 * A fire can be joined to a fill only if it placed a priced entry or add.
 * EXCLUDED (documented pitfall in DESK_PROFITABILITY.md): stop_move rows (they move a stop,
 * they do not fill at a trigger) and indicator-triggered reduces (trigger 0, no price).
 */
export function isAttributableFire(fire: FireRow, rung: RungRow | undefined): boolean {
  if (!rung || fire.status !== 'filled') return false;
  if (rung.action === 'stop_move') return false;
  if (rung.trigger_kind === 'indicator' || !rung.trigger_px) return false;
  return rung.action === 'open' || rung.action === 'add';
}

const LEAD_MS = 120_000;

/** Tags each trip with the ladder whose open/add fire fell inside its window. Mutates and returns trips. */
export function attributeTrips(
  trips: RoundTrip[],
  fires: FireRow[],
  rungs: RungRow[],
  outcomes: OutcomeRow[],
): RoundTrip[] {
  const rungById = new Map(rungs.map((r) => [r.id, r]));
  const outById = new Map(outcomes.map((o) => [o.ladder_id, o]));
  const usable = fires.filter((f) => isAttributableFire(f, rungById.get(f.rung_id)));
  for (const t of trips) {
    const cands = usable
      .filter((f) => {
        const r = rungById.get(f.rung_id);
        const at = Date.parse(f.fired_at);
        return r?.coin === t.coin && at >= t.t0 - LEAD_MS && at <= t.t1;
      })
      .sort((a, b) => {
        const ao = rungById.get(a.rung_id)?.action === 'open' ? 0 : 1;
        const bo = rungById.get(b.rung_id)?.action === 'open' ? 0 : 1;
        return ao - bo || Math.abs(Date.parse(a.fired_at) - t.t0) - Math.abs(Date.parse(b.fired_at) - t.t0);
      });
    if (!cands.length) continue;
    t.ladderId = cands[0].ladder_id;
    t.otherLadderIds = [...new Set(cands.map((c) => c.ladder_id))].filter((id) => id !== t.ladderId);
    t.setup = outById.get(t.ladderId)?.setup_type ?? 'unresolved-ladder';
  }
  return trips;
}

// ------------------------------------------------------------- reconciliation

const CLOSED = new Set(['won', 'lost', 'scratch']);

export interface SetupRecon {
  setup: string;
  fillsN: number;
  fillsNet: number;
  fillsNetExFunding: number;
  outcomesClosedN: number;
  outcomesNet: number;
  outcomesMeanR: number | null;
  delta: number;
}

export interface Mismatch {
  ladderId: string;
  title: string;
  setup: string;
  outcomeNet: number;
  tripNetExFunding: number | null;
  tripNetWithFunding: number | null;
  windowFillNet: number | null;
  delta: number;
  reason: string;
}

export function windowFillNet(fills: HlFillRow[], coin: string, startIso: string | null, endIso: string | null): number {
  if (!startIso) return 0;
  const s = Date.parse(startIso);
  const e = endIso ? Date.parse(endIso) : Number.POSITIVE_INFINITY;
  return fills
    .filter((f) => f.coin === coin && f.time >= s && f.time <= e)
    .reduce((a, f) => a + Number(f.closedPnl) - Number(f.fee), 0);
}

export function reconcile(
  trips: RoundTrip[],
  outcomes: OutcomeRow[],
  fills: HlFillRow[],
  tol = 0.05,
): { bySetup: SetupRecon[]; mismatches: Mismatch[]; outcomeNetBasis: string } {
  const closed = outcomes.filter((o) => CLOSED.has(o.outcome));
  const setups = [...new Set([...trips.map((t) => t.setup), ...closed.map((o) => o.setup_type)])].sort();
  const bySetup: SetupRecon[] = setups.map((setup) => {
    const ts = trips.filter((t) => t.setup === setup);
    const os = closed.filter((o) => o.setup_type === setup);
    const rs = os.filter((o) => o.realized_r != null);
    const fillsNet = ts.reduce((s, t) => s + t.net, 0);
    const outcomesNet = os.reduce((s, o) => s + (o.realized_pnl_usd ?? 0), 0);
    return {
      setup,
      fillsN: ts.length,
      fillsNet,
      fillsNetExFunding: ts.reduce((s, t) => s + t.pnl - t.fee, 0),
      outcomesClosedN: os.length,
      outcomesNet,
      outcomesMeanR: rs.length ? rs.reduce((s, o) => s + (o.realized_r ?? 0), 0) / rs.length : null,
      delta: fillsNet - outcomesNet,
    };
  });

  const mismatches: Mismatch[] = [];
  for (const o of closed) {
    const ts = trips.filter((t) => t.ladderId === o.ladder_id);
    const outNet = o.realized_pnl_usd ?? 0;
    const exF = ts.length ? ts.reduce((s, t) => s + t.pnl - t.fee, 0) : null;
    const withF = ts.length ? ts.reduce((s, t) => s + t.net, 0) : null;
    const win = windowFillNet(fills, o.coin, o.window_start, o.window_end);
    const overlapping = closed.filter(
      (p) =>
        p.ladder_id !== o.ladder_id &&
        p.coin === o.coin &&
        p.window_start &&
        o.window_start &&
        Date.parse(p.window_start) <= Date.parse(o.window_end ?? '9999') &&
        Date.parse(o.window_start) <= Date.parse(p.window_end ?? '9999') &&
        Math.abs(windowFillNet(fills, p.coin, p.window_start, p.window_end)) > tol,
    );
    const delta = (exF ?? 0) - outNet;
    const windowDays = o.window_start && o.window_end ? (Date.parse(o.window_end) - Date.parse(o.window_start)) / 864e5 : 0;
    let reason: string | null = null;
    if (!ts.length) reason = Math.abs(outNet) > tol ? 'outcome has P&L but no round trip attributed to this ladder' : null;
    else if (Math.abs(delta) <= tol) reason = null;
    else if (overlapping.length && Math.abs(win - outNet) <= tol) {
      reason = `overlapping outcome windows on ${o.coin} (${overlapping.map((p) => p.ladder_id.slice(0, 8)).join(',')}): same fills counted in more than one outcome (window is ${windowDays.toFixed(0)} days long)`;
    } else if (Math.abs(win - outNet) <= tol) {
      reason = 'outcome equals fills inside its window; the attributed round trip extends outside the window';
    } else if (ts.some((t) => t.otherLadderIds.length)) {
      reason = 'round trip shared by several ladders; P&L split differs';
    } else {
      reason = 'unexplained: neither trip nor window fill sum matches the stored outcome';
    }
    if (reason) {
      mismatches.push({
        ladderId: o.ladder_id,
        title: o.title,
        setup: o.setup_type,
        outcomeNet: outNet,
        tripNetExFunding: exF,
        tripNetWithFunding: withF,
        windowFillNet: win,
        delta,
        reason,
      });
    }
  }
  // Trips with no ladder outcome at all, and P&L attributed to unresolved ladders.
  for (const t of trips.filter((x) => x.setup === 'unresolved-ladder')) {
    mismatches.push({
      ladderId: t.ladderId ?? '',
      title: `${t.coin} ${t.side} ${new Date(t.t0).toISOString()}`,
      setup: t.setup,
      outcomeNet: 0,
      tripNetExFunding: t.pnl - t.fee,
      tripNetWithFunding: t.net,
      windowFillNet: null,
      delta: t.pnl - t.fee,
      reason: 'ladder fired but has no ladder_outcomes row yet (unresolved)',
    });
  }
  return { bySetup, mismatches, outcomeNetBasis: 'realized_pnl_usd as stored (compared with closedPnl minus fee)' };
}

// ----------------------------------------------------------------- straddles

export interface StraddleRow {
  ladderId: string;
  title: string;
  eventTemplate: boolean;
  outcome: string;
  fired: boolean;
  plannedRiskSlipAware: number | null;
  nominalRisk: number | null;
  net: number;
  slipAwareR: number | null;
  slipAwareRStored: number | null;
  nominalR: number | null;
}

export function straddleReport(
  outcomes: OutcomeRow[],
  rungs: RungRow[],
  fires: FireRow[],
): { rows: StraddleRow[]; fired: number; neverFilled: number; firedTemplateOnly: number } {
  const firedOpenRungs = new Set(
    fires.filter((fire) => fire.status === 'filled').map((fire) => fire.rung_id),
  );
  const rows: StraddleRow[] = outcomes
    .filter((o) => /straddle/i.test(o.title) && !/runner management/i.test(o.title))
    .map((o) => {
      const nominal = rungs
        .filter((r) => r.ladder_id === o.ladder_id && r.action === 'open')
        .reduce((s, r) => s + (r.risk_usd ?? 0), 0);
      const fired = rungs.some(
        (r) => r.ladder_id === o.ladder_id && r.action === 'open' && firedOpenRungs.has(r.id),
      );
      const net = o.realized_pnl_usd ?? 0;
      const planned = o.planned_risk_usd;
      return {
        ladderId: o.ladder_id,
        title: o.title,
        eventTemplate: /event template/i.test(o.title),
        outcome: o.outcome,
        fired,
        plannedRiskSlipAware: planned,
        nominalRisk: nominal > 0 ? nominal : null,
        net,
        slipAwareR: fired && planned ? net / planned : null,
        slipAwareRStored: o.realized_r,
        nominalR: fired && nominal > 0 ? net / nominal : null,
      };
    });
  return {
    rows,
    fired: rows.filter((r) => r.fired).length,
    neverFilled: rows.filter((r) => !r.fired).length,
    firedTemplateOnly: rows.filter((r) => r.fired && r.eventTemplate).length,
  };
}

// --------------------------------------------------------------------- scout

export interface HypRow {
  lane: string | null;
  coin: string;
  status: string;
  excluded: boolean | null;
  created_at: string;
  resolved_at: string | null;
  realized_r: number | null;
  realized_pnl_usd: number | null;
}

export interface LaneStats {
  lane: string;
  n: number;
  winRate: number;
  meanR: number;
  sumR: number;
  netUsd: number;
}

const isClosedHyp = (h: HypRow): boolean => h.status !== 'open' && !h.excluded && h.realized_r != null && !!h.lane;

function laneStats(lane: string, rows: HypRow[]): LaneStats {
  const r = rows.map((h) => h.realized_r ?? 0);
  return {
    lane,
    n: rows.length,
    winRate: rows.length ? rows.filter((h) => (h.realized_r ?? 0) > 0).length / rows.length : 0,
    meanR: rows.length ? r.reduce((a, b) => a + b, 0) / rows.length : 0,
    sumR: r.reduce((a, b) => a + b, 0),
    netUsd: rows.reduce((s, h) => s + (h.realized_pnl_usd ?? 0), 0),
  };
}

export function scoutLaneStats(hyps: HypRow[]): LaneStats[] {
  const closed = hyps.filter(isClosedHyp);
  const lanes = [...new Set(closed.map((h) => h.lane as string))].sort();
  return lanes.map((l) => laneStats(l, closed.filter((h) => h.lane === l)));
}

/** Drops the closes inside the 5-day window (anchored at any entry) that holds the largest summed R. */
export function removeLargestCluster(
  rows: HypRow[],
  windowDays = 5,
): { before: LaneStats; after: LaneStats; windowStart: string | null; removed: number } {
  const closed = rows.filter(isClosedHyp).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const span = windowDays * 864e5;
  let best = { sum: Number.NEGATIVE_INFINITY, start: 0, idx: [] as number[] };
  closed.forEach((anchor) => {
    const s = Date.parse(anchor.created_at);
    const idx = closed
      .map((h, i) => ({ t: Date.parse(h.created_at), i }))
      .filter((x) => x.t >= s && x.t < s + span)
      .map((x) => x.i);
    const sum = idx.reduce((a, i) => a + (closed[i].realized_r ?? 0), 0);
    if (sum > best.sum) best = { sum, start: s, idx };
  });
  const drop = new Set(best.idx);
  const lane = closed[0]?.lane ?? 'none';
  return {
    before: laneStats(lane, closed),
    after: laneStats(lane, closed.filter((_, i) => !drop.has(i))),
    windowStart: closed.length ? new Date(best.start).toISOString() : null,
    removed: drop.size,
  };
}
