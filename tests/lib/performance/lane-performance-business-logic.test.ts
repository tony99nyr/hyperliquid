import { describe, expect, it } from 'vitest';
import { buildLanePerformanceReport, isEventStraddle, type ReportInput } from '@/lib/performance/lane-performance-business-logic';
import { buildExpectancyReport, DEFAULT_EXPECTANCY_BAR } from '@/lib/skills/ladder-expectancy-business-logic';
import { buildLaneScorecards } from '@/lib/scout/scout-review-business-logic';
import { registeredLaneBar } from '@/lib/scout/scout-lane-bars-business-logic';

const day = (n: number) => new Date(Date.parse('2026-10-01T00:00:00Z') + n * 86_400_000).toISOString();
const input = (): ReportInput => ({
  now: day(20), horizonEnd: '2026-11-20', seed: 17, snapshots: [], notes: [],
  ladders: [
    { id: 'a', title: 'ETH CPI straddle — long leg (event template)', mode: 'live', oco_group_id: 'group' },
    { id: 'b', title: 'ETH CPI straddle — short leg (event template)', mode: 'live', oco_group_id: 'group' },
    { id: 'c', title: 'ETH runner after straddle', mode: 'live', oco_group_id: null },
  ],
  rungs: [{ ladder_id: 'a', action: 'open', risk_usd: 10 }, { ladder_id: 'b', action: 'open', risk_usd: 10 }],
  outcomes: [
    { ladder_id: 'a', title: 'ETH CPI straddle', setup_type: 'breakout-long-single', mode: 'live', outcome: 'won', planned_risk_usd: 12, realized_pnl_usd: 6, realized_r: .5, resolved_at: day(0) },
    { ladder_id: 'b', title: 'ETH CPI straddle', setup_type: 'breakdown-short-single', mode: 'live', outcome: 'never_filled', planned_risk_usd: 12, realized_pnl_usd: 0, realized_r: 0, resolved_at: day(0) },
    { ladder_id: 'a', title: 'ETH CPI straddle', setup_type: 'breakout-long-single', mode: 'live', outcome: 'lost', planned_risk_usd: 12, realized_pnl_usd: -3, realized_r: -.25, resolved_at: day(4) },
    { ladder_id: 'a', title: 'ETH CPI straddle', setup_type: 'breakout-long-single', mode: 'live', outcome: 'won', planned_risk_usd: 12, realized_pnl_usd: 6, realized_r: .5, resolved_at: day(10) },
  ],
  hypotheses: [{ id: 'h1', lane: 'htf-trend', realized_r: .2, realized_pnl_usd: 2, resolved_at: day(2), excluded: false, status: 'confirmed' },
    { id: 'h2', lane: 'htf-trend', realized_r: 2, realized_pnl_usd: 20, resolved_at: day(3), excluded: true, status: 'confirmed' }],
  markers: [{ id: 'm1', at: day(7), kind: 'process', lanes: ['event-straddle'], title: 'Changed gate', note: '', source: 'manual', ref: null,
    proposed_by: 'agent', confirmed_by: 'operator', confirmed_at: day(8), created_at: day(7) },
    { id: 'm2', at: day(1), kind: 'system', lanes: [], title: 'Unconfirmed', note: '', source: 'manual', ref: null,
      proposed_by: 'agent', confirmed_by: null, confirmed_at: null, created_at: day(1) }],
  scoutCards: [{ lane: 'htf-trend', verdict: 'continue', tradeCount: 1, updatedAt: day(20) }],
});

describe('lane performance', () => {
  it('classifies paired event-template legs, groups five-day episodes, and keeps both R units', () => {
    const report = buildLanePerformanceReport(input());
    const lane = report.lanes.find((row) => row.id === 'event-straddle');
    expect(lane?.episodes).toBe(2);
    expect(lane?.netUsd.value).toBe(9);
    expect(lane?.netSlipR.value).toBe(.75);
    expect(lane?.netNominalR.value).toBeCloseTo(.9);
    expect(report.overview.live.at(-1)?.usd.value).toBe(9);
    expect(report.overview.scout.at(-1)?.usd.value).toBe(2);
    expect(lane?.meanRPerTrade.value).toBeCloseTo(.25);
    expect(lane?.meanRPerTrade.n).toBe(3);
    expect(lane?.meanRPerEpisode.value).toBeCloseTo(.375);
    expect(lane?.meanRPerEpisode.n).toBe(2);
  });

  it('uses canonical verdicts for the same scout card and live outcomes', () => {
    const data = input();
    const scout = buildLaneScorecards({
      positions: [{ lane: 'htf-trend', coin: 'ETH', side: 'flat', realizedPnlUsd: -10, feesPaidUsd: 0 }],
      hypotheses: Array.from({ length: 6 }, () => ({ lane: 'htf-trend', status: 'invalidated', realizedR: -1 })),
      fundingByLane: {}, periodDays: 121,
      configFor: (lane) => registeredLaneBar(lane)!.config,
    })[0];
    data.scoutCards = [{ lane: scout.lane, verdict: scout.card.verdict, tradeCount: scout.card.tradeCount, updatedAt: day(20) }];
    expect(buildLanePerformanceReport(data).lanes.find((lane) => lane.id === 'htf-trend')?.verdict).toBe(scout.card.verdict.toUpperCase());
    const canonicalLive = buildExpectancyReport(data.outcomes.filter((row) => ['won', 'lost', 'scratch'].includes(row.outcome)).map((row) => ({
      ladderId: row.ladder_id, title: row.title, coin: 'ETH', side: 'long' as const, mode: 'live' as const,
      setupType: 'event-straddle', signalScore: null, timingScore: null, plannedRiskUsd: row.planned_risk_usd,
      realizedPnlUsd: row.realized_pnl_usd, feesUsd: null, realizedR: row.realized_r,
      outcome: row.outcome as 'won' | 'lost' | 'scratch', windowStartMs: 0, windowEndMs: Date.parse(row.resolved_at), notes: null,
    })), DEFAULT_EXPECTANCY_BAR);
    expect(buildLanePerformanceReport(data).lanes.find((lane) => lane.id === 'event-straddle')?.verdict)
      .toBe(canonicalLive.perSetup[0].verdict);
  });

  it('preserves the fixed scout scorecard verdicts across registered lanes', () => {
    const data = input();
    const verdicts = { 'compression-straddle': 'kill', 'htf-trend': 'continue',
      'trend-follow': 'kill', reversion: 'kill', 'leader-follow': 'kill' };
    data.hypotheses = Object.keys(verdicts).map((lane, index) => ({ id: `h${index}`, lane,
      realized_r: -.1, realized_pnl_usd: -1, resolved_at: day(index), excluded: false, status: 'invalidated' }));
    data.scoutCards = Object.entries(verdicts).map(([lane, verdict]) => ({ lane, verdict, tradeCount: 6, updatedAt: day(20) }));
    const report = buildLanePerformanceReport(data);
    for (const [lane, verdict] of Object.entries(verdicts)) {
      expect(report.lanes.find((row) => row.id === lane)?.verdict).toBe(verdict.toUpperCase());
    }
  });

  it('labels scout R and uses trades rather than episodes for its per-trade mean', () => {
    const data = input();
    data.hypotheses = Array.from({ length: 6 }, (_, index) => ({ id: `h${index}`, lane: 'reversion', realized_r: -.55,
      realized_pnl_usd: -5.5, resolved_at: day(index), excluded: false, status: 'invalidated' }));
    data.scoutCards = [{ lane: 'reversion', verdict: 'kill', tradeCount: 6, updatedAt: day(20) }];
    const lane = buildLanePerformanceReport(data).lanes.find((row) => row.id === 'reversion')!;
    expect(lane.meanRPerTrade.value).toBeCloseTo(-.55);
    expect(lane.meanRPerTrade).toMatchObject({ n: 6, unit: 'r' });
    expect(lane.meanRPerEpisode.value).toBeCloseTo(-3.3);
    expect(lane.meanRPerEpisode).toMatchObject({ n: 1, unit: 'r' });
    expect(lane.netSlipR.value).toBeNull();
    expect(lane.plannedRiskUsd.value).toBeNull();
    expect(lane.verdict).toBe('KILL');
  });

  it('returns null for a mean when a trade has no realised R', () => {
    const data = input();
    data.hypotheses.push({ id: 'h3', lane: 'htf-trend', realized_r: null, realized_pnl_usd: 1,
      resolved_at: day(3), excluded: false, status: 'resolved' });
    const lane = buildLanePerformanceReport(data).lanes.find((row) => row.id === 'htf-trend')!;
    expect(lane.meanRPerTrade).toMatchObject({ value: null, n: 2, unit: 'r' });
    expect(lane.meanRPerEpisode).toMatchObject({ value: null, n: 1, unit: 'r' });
  });

  it('computes remaining closes, rate, and ETA, including a zero-rate reason', () => {
    const data = input();
    const active = buildLanePerformanceReport(data).lanes.find((row) => row.id === 'event-straddle')!;
    expect(active.timeToVerdict.remaining).toBe(7);
    expect(active.timeToVerdict.ratePerDay.value).toBeCloseTo(3 / 90);
    expect(active.timeToVerdict.eta).toBe(day(230).slice(0, 10));
    data.now = day(200);
    const stale = buildLanePerformanceReport(data).lanes.find((row) => row.id === 'event-straddle')!;
    expect(stale.timeToVerdict.eta).toBeNull();
    expect(stale.timeToVerdict.reason).toMatch(/no closes/i);
  });

  it('recognises only a titled OCO pair as an event straddle', () => {
    const groups = new Map([['g', 2]]);
    expect(isEventStraddle({ id: 'a', title: 'CPI straddle', mode: 'live', oco_group_id: 'g' }, groups)).toBe(true);
    expect(isEventStraddle({ id: 'b', title: 'CPI breakout', mode: 'live', oco_group_id: 'g' }, groups)).toBe(false);
    expect(isEventStraddle({ id: 'c', title: 'CPI straddle', mode: 'live', oco_group_id: null }, groups)).toBe(false);
  });

  it('anchors episode clusters to their first close and starts a new cluster after day five', () => {
    const data = input();
    data.outcomes = [0, 5, 6, 11].map((offset) => ({ ladder_id: 'a', title: 'CPI straddle',
      setup_type: 'breakout-long-single', mode: 'live', outcome: 'won', planned_risk_usd: 10,
      realized_pnl_usd: 1, realized_r: .1, resolved_at: day(offset) }));
    const lane = buildLanePerformanceReport(data).lanes.find((row) => row.id === 'event-straddle')!;
    expect(lane.episodes).toBe(2);
    expect(lane.trades).toBe(4);
    expect(lane.meanRPerTrade.value).toBeCloseTo(.1);
    expect(lane.meanRPerEpisode.value).toBeCloseTo(.2);
  });

  it('keeps the observed episode rate distinct from the close rate', () => {
    const report = buildLanePerformanceReport(input());
    const lane = report.lanes.find((row) => row.id === 'event-straddle')!;
    expect(lane.signalRatePerDay.value).toBeCloseTo(2 / 90);
    expect(lane.timeToVerdict.ratePerDay.value).toBeCloseTo(3 / 90);
    expect(report.forecast.expectedMonthly.value).toBeCloseTo(3);
    expect(report.forecast.realisedMonthly.value).toBeCloseTo(3);
  });

  it('splits only at confirmed markers', () => {
    const lane = buildLanePerformanceReport(input()).lanes.find((row) => row.id === 'event-straddle');
    expect(lane?.markerSplits).toHaveLength(1);
    expect(lane?.markerSplits[0].before.usd.value).toBe(3);
    expect(lane?.markerSplits[0].before.usd.n).toBe(1);
    expect(lane?.markerSplits[0].after.usd.value).toBe(6);
  });

  it('repeats the same forecast and hash for identical inputs', () => {
    const first = buildLanePerformanceReport(input()).forecast;
    const second = buildLanePerformanceReport(input()).forecast;
    expect(first).toEqual(second);
    expect(first.p5.value).toBeLessThanOrEqual(first.p95.value ?? 0);
    expect(first.p5.value).toBeLessThanOrEqual(first.p50.value ?? 0);
    expect(first.p50.value).toBeLessThanOrEqual(first.p95.value ?? 0);
    expect(first.p95Drawdown30d.value).toBeGreaterThanOrEqual(0);
    expect(first.scope).toMatch(/Live ladder/);
    const changed = input(); changed.seed = 18;
    expect(buildLanePerformanceReport(changed).forecast.inputsHash).not.toBe(first.inputsHash);
  });

  it('excludes killed and stale live lanes from forecast inputs', () => {
    const data = input();
    data.outcomes.push(...Array.from({ length: 10 }, (_, index) => ({
      ladder_id: 'k', title: 'Killed', setup_type: 'killed', mode: 'live', outcome: 'lost', planned_risk_usd: 10,
      realized_pnl_usd: -10, realized_r: -1, resolved_at: day(index),
    })));
    const forecast = buildLanePerformanceReport(data).forecast;
    expect(buildLanePerformanceReport(data).lanes.find((lane) => lane.id === 'killed')?.verdict).toBe('KILL');
    expect(forecast.includedLanes).not.toContain('killed');
    data.now = day(200);
    expect(buildLanePerformanceReport(data).forecast.includedLanes).toEqual([]);
  });
});
