import type { LanePerformanceReport, Figure, LaneResult, SeriesPoint } from '../../src/lib/performance/lane-performance-business-logic';

const day = 86_400_000;
const now = Date.parse('2026-10-24T12:00:00.000Z');
const date = (offset: number) => new Date(now + offset * day).toISOString();
const fig = (value: number | null, unit: Figure['unit'] = 'usd', n = 8): Figure => ({ value, n, unit, source: 'synthetic-fixture' });
const point = (offset: number, usd: number, r: number): SeriesPoint => ({
  at: date(offset), usd: fig(usd), r: fig(r, 'r'), slipR: fig(r - 0.03, 'r_slip'), nominalR: fig(r + 0.02, 'r_nominal'),
});
const series = (base: number): SeriesPoint[] => Array.from({ length: 36 }, (_, index) => {
  const offset = -90 + Math.round(index * 90 / 35);
  return point(offset, base + index * (index % 4 === 0 ? -0.6 : 1.8), (index % 5 - 2) * 0.17);
});
const bar = { minCloses: 12, minMeanR: 0.2, killMeanR: -0.25, killAfterCloses: 12, slowBleedDays: 30, slowBleedMinCloses: 8, source: 'synthetic-fixture' };
const verdicts = ['KILL', 'CONTINUE', 'COLLECT', 'HOLD', 'UNREGISTERED', 'CONTINUE', 'COLLECT', 'HOLD', 'KILL', 'CONTINUE'];
const lanes: LaneResult[] = verdicts.map((verdict, index) => {
  const kind = index % 2 ? 'scout' : 'live';
  const laneSeries = index === 9 ? [] : series(index * 3 - 8);
  const rUnit = kind === 'live' ? 'r_slip' : 'r';
  return {
    id: `synthetic-${kind}-${index + 1}`, kind, verdict,
    persistedVerdict: index === 3 ? { verdict: 'CONTINUE', updatedAt: date(-14) } : null,
    bar, trades: laneSeries.length, episodes: laneSeries.length,
    signalRatePerDay: fig(0.12 + index * 0.015, 'per_day'), plannedRiskUsd: fig(125 + index * 20),
    netUsd: fig((index - 3) * 18.75), netR: fig(kind === 'scout' ? (index - 4) * 0.21 : null, 'r'),
    netSlipR: fig(kind === 'live' ? (index - 4) * 0.19 : null, 'r_slip'),
    netNominalR: fig(kind === 'live' ? (index - 4) * 0.23 : null, 'r_nominal'),
    meanRPerTrade: fig((index - 4) * 0.11, rUnit), meanRPerEpisode: fig((index - 4) * 0.14, rUnit),
    timeToVerdict: { current: laneSeries.length, required: 12, remaining: Math.max(0, 12 - laneSeries.length), ratePerDay: fig(0.2, 'per_day'), eta: '2026-11-01', reason: null },
    series: laneSeries,
    markerSplits: index < 4 ? [
      { markerId: 'synthetic-confirmed-a', before: { usd: fig(-42), meanR: fig(-0.18, rUnit) }, after: { usd: fig(76), meanR: fig(0.31, rUnit) } },
      { markerId: 'synthetic-confirmed-b', before: { usd: fig(76), meanR: fig(0.31, rUnit) }, after: { usd: fig(94), meanR: fig(0.38, rUnit) } },
    ] : [],
  };
});
const overviewSeries = (shift: number) => Array.from({ length: 36 }, (_, index) => point(-90 + Math.round(index * 90 / 35), shift + index * (index % 3 ? 2.7 : -1.1), (index % 7 - 3) * 0.13));
const forecastFan = Array.from({ length: 30 }, (_, index) => {
  const at = new Date(now + (index + 1) * day).toISOString().slice(0, 10);
  return { at, p5: fig(-35 + index * 0.3), p25: fig(-12 + index * 0.5), p50: fig(index * 1.4), p75: fig(16 + index * 1.9), p95: fig(42 + index * 2.6) };
});

export const lanePerformanceReportFixture: LanePerformanceReport = {
  schemaVersion: 1, generatedAt: date(0), notes: ['Synthetic verifier data, no account records.'], lanes,
  overview: { live: overviewSeries(12), scout: overviewSeries(-9) },
  markers: [
    { id: 'synthetic-confirmed-a', at: date(-45), kind: 'process', lanes: ['synthetic-live-1'], title: 'Confirmed sizing review', note: 'Synthetic marker with before and after data.', source: 'fixture', ref: null, proposed_by: 'fixture-operator', confirmed_by: 'fixture-operator', confirmed_at: date(-44), created_at: date(-45) },
    { id: 'synthetic-confirmed-b', at: date(-20), kind: 'risk', lanes: [], title: 'Confirmed risk limit', note: 'Synthetic confirmed marker.', source: 'fixture', ref: null, proposed_by: 'fixture-operator', confirmed_by: 'fixture-operator', confirmed_at: date(-19), created_at: date(-20) },
    { id: 'synthetic-proposed', at: date(0), kind: 'process', lanes: [], title: 'Proposed review', note: 'Synthetic proposed marker.', source: 'fixture', ref: null, proposed_by: 'fixture-operator', confirmed_by: null, confirmed_at: null, created_at: date(0) },
  ],
  forecast: { seed: 42, iterations: 2000, horizonEnd: forecastFan.at(-1)!.at, scope: 'Synthetic live lane fixture', includedLanes: ['synthetic-live-2', 'synthetic-live-4'], inputsHash: 'synthetic-fixture', fan: forecastFan,
    p5: fig(-26), p25: fig(-8), p50: fig(19), p75: fig(43), p95: fig(78), pPositive: fig(0.68, 'probability'), expectedMonthly: fig(56), realisedMonthly: fig(39), p95Drawdown30d: fig(31),
    method: { name: 'synthetic-bootstrap', blockSize: 2, signalWindowDays: 90, description: 'Synthetic forecast fixture.' } },
  snapshots: [
    { id: 'synthetic-scored', made_at: date(-60), horizon_end: date(-30), scope: 'Synthetic live fixture', inputs_hash: 'scored-fixture', p5: fig(-22), p25: fig(-8), p50: fig(12), p75: fig(28), p95: fig(46), expected_monthly: fig(32), p_positive: fig(0.62, 'probability'), method: { sampleN: 24 }, actual: fig(18), scored_at: date(-29) },
    { id: 'synthetic-unscored', made_at: date(-30), horizon_end: date(0), scope: 'Synthetic live fixture', inputs_hash: 'unscored-fixture', p5: fig(-18), p25: fig(-3), p50: fig(17), p75: fig(34), p95: fig(59), expected_monthly: fig(41), p_positive: fig(0.7, 'probability'), method: { sampleN: 28 }, actual: fig(null), scored_at: null },
  ],
};
