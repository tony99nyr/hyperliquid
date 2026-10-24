import { describe, it, expect } from 'vitest';
import {
  buildRoundTrips, attributeTrips, summarise, reconcile, straddleReport, removeLargestCluster, isAttributableFire,
  type HlFillRow, type RungRow, type FireRow, type OutcomeRow, type HypRow,
} from '@/lib/backtest/profit-review-business-logic';

const T0 = Date.parse('2026-09-01T00:00:00Z');
const H = 3.6e6;
const fill = (o: Partial<HlFillRow> & Pick<HlFillRow, 'side' | 'sz' | 'startPosition' | 'dir' | 'time'>): HlFillRow => ({
  coin: 'ETH', px: '100', closedPnl: '0', fee: '0.1', ...o,
});

describe('buildRoundTrips', () => {
  const fills: HlFillRow[] = [
    fill({ time: T0, side: 'B', sz: '2', startPosition: '0', dir: 'Open Long' }),
    fill({ time: T0 + H, side: 'A', sz: '1', startPosition: '2', dir: 'Close Long', closedPnl: '5' }),
    fill({ time: T0 + 2 * H, side: 'A', sz: '1', startPosition: '1', dir: 'Close Long', closedPnl: '-1' }),
    fill({ time: T0 + 3 * H, side: 'A', sz: '1', startPosition: '0', dir: 'Open Short', coin: 'BTC' }),
    fill({ time: T0, side: 'B', sz: '10', startPosition: '0', dir: 'Buy', coin: '@107' }),
  ];
  const funding = [
    { time: T0 + H, delta: { coin: 'ETH', usdc: '-0.5' } },
    { time: T0 + 9 * H, delta: { coin: 'ETH', usdc: '-9' } },
  ];
  it('nets fees and funding flat-to-flat, skips spot and reports open positions', () => {
    const r = buildRoundTrips(fills, funding);
    expect(r.excludedFills).toBe(1);
    expect(r.trips).toHaveLength(1);
    expect(r.trips[0].net).toBeCloseTo(4 - 0.3 - 0.5, 9);
    expect(r.open).toEqual([{ coin: 'BTC', since: T0 + 3 * H }]);
  });
  it('summarises win rate and payoff', () => {
    const r = buildRoundTrips(fills, funding);
    const s = summarise([...r.trips, { ...r.trips[0], net: -1 }]);
    expect(s.n).toBe(2);
    expect(s.winRate).toBe(0.5);
    expect(s.payoff).toBeCloseTo(3.2, 9);
  });
});

describe('fire join', () => {
  const rungs: RungRow[] = [
    { id: 'r-open', ladder_id: 'L1', coin: 'ETH', action: 'open', trigger_kind: 'price_above', trigger_px: 100, risk_usd: 5 },
    { id: 'r-sm', ladder_id: 'L1', coin: 'ETH', action: 'stop_move', trigger_kind: 'price_above', trigger_px: 105, risk_usd: null },
    { id: 'r-ind', ladder_id: 'L2', coin: 'ETH', action: 'reduce', trigger_kind: 'indicator', trigger_px: 0, risk_usd: null },
  ];
  const fire = (id: string, rung_id: string, ladder_id: string, at: number): FireRow => ({ id, rung_id, ladder_id, status: 'filled', fired_at: new Date(at).toISOString() });
  const fires = [fire('a', 'r-sm', 'L1', T0), fire('b', 'r-ind', 'L2', T0 + 1000), fire('c', 'r-open', 'L1', T0 + 5000)];
  it('excludes stop_move and trigger-0 indicator reduces', () => {
    expect(isAttributableFire(fires[0], rungs[1])).toBe(false);
    expect(isAttributableFire(fires[1], rungs[2])).toBe(false);
    expect(isAttributableFire(fires[2], rungs[0])).toBe(true);
  });
  const outcome = (o: Partial<OutcomeRow>): OutcomeRow => ({
    ladder_id: 'L1', title: 't', coin: 'ETH', side: 'long', setup_type: 's', planned_risk_usd: 100, realized_pnl_usd: 0,
    fees_usd: 0, realized_r: 0, outcome: 'won', window_start: new Date(T0 - H).toISOString(), window_end: new Date(T0 + 10 * H).toISOString(), ...o,
  });
  it('attributes a trip and reconciles, flagging overlapping windows', () => {
    const fills = [
      fill({ time: T0, side: 'B', sz: '1', startPosition: '0', dir: 'Open Long' }),
      fill({ time: T0 + H, side: 'A', sz: '1', startPosition: '1', dir: 'Close Long', closedPnl: '10.1' }),
    ];
    const { trips } = buildRoundTrips(fills, []);
    const outs = [outcome({ realized_pnl_usd: 9.9 }), outcome({ ladder_id: 'L9', realized_pnl_usd: 9.9 })];
    attributeTrips(trips, fires, rungs, outs);
    expect(trips[0].ladderId).toBe('L1');
    expect(trips[0].setup).toBe('s');
    const rec = reconcile(trips, outs, fills);
    expect(rec.mismatches.map((m) => m.ladderId)).toEqual(['L9']);
  });
  it('reports clean match when outcome equals trip', () => {
    const fills = [
      fill({ time: T0, side: 'B', sz: '1', startPosition: '0', dir: 'Open Long' }),
      fill({ time: T0 + H, side: 'A', sz: '1', startPosition: '1', dir: 'Close Long', closedPnl: '10.1' }),
    ];
    const { trips } = buildRoundTrips(fills, []);
    const outs = [outcome({ realized_pnl_usd: 9.9 })];
    attributeTrips(trips, fires, rungs, outs);
    expect(reconcile(trips, outs, fills).mismatches).toHaveLength(0);
  });
});

describe('straddleReport', () => {
  it('counts fired vs never_filled with both R units', () => {
    const outs: OutcomeRow[] = [
      { ladder_id: 'A', title: 'BTC CPI straddle - short leg (event template)', coin: 'BTC', side: 'short', setup_type: 'x', planned_risk_usd: 101.44, realized_pnl_usd: 8.68, fees_usd: 0.79, realized_r: 0.09, outcome: 'won', window_start: null, window_end: null },
      { ladder_id: 'B', title: 'BTC CPI straddle - long leg (event template)', coin: 'BTC', side: 'long', setup_type: 'x', planned_risk_usd: 132, realized_pnl_usd: 0, fees_usd: 0, realized_r: 0, outcome: 'never_filled', window_start: null, window_end: null },
      { ladder_id: 'C', title: 'ETH runner management (post-straddle)', coin: 'ETH', side: 'short', setup_type: 'x', planned_risk_usd: 0, realized_pnl_usd: 30, fees_usd: 1, realized_r: null, outcome: 'scratch', window_start: null, window_end: null },
    ];
    const rungs: RungRow[] = [{ id: 'r', ladder_id: 'A', coin: 'BTC', action: 'open', trigger_kind: 'price_below', trigger_px: 1, risk_usd: 12 }];
    const r = straddleReport(outs, rungs);
    expect(r.fired).toBe(1);
    expect(r.neverFilled).toBe(1);
    expect(r.rows[0].slipAwareR).toBeCloseTo(0.0856, 3);
    expect(r.rows[0].nominalR).toBeCloseTo(0.7233, 3);
  });
});

describe('removeLargestCluster', () => {
  const h = (day: string, r: number): HypRow => ({ lane: 'htf-trend', coin: 'ETH', status: 'closed', excluded: false, created_at: `${day}T00:00:00Z`, resolved_at: null, realized_r: r, realized_pnl_usd: r * 10 });
  it('drops the best 5-day window', () => {
    const rows = [h('2026-08-20', 2), h('2026-08-21', 2), h('2026-08-22', 2), h('2026-09-10', -0.5), h('2026-09-20', 0.5)];
    const r = removeLargestCluster(rows, 5);
    expect(r.removed).toBe(3);
    expect(r.before.sumR).toBeCloseTo(6, 9);
    expect(r.after.n).toBe(2);
    expect(r.after.sumR).toBeCloseTo(0, 9);
  });
});
