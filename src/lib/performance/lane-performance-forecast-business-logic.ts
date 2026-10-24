/** Seeded block bootstrap for prospective live lane returns. No clock or I/O. */
import { mulberry32, percentile } from '@/lib/backtest/significance-business-logic';
import type { Figure, LaneResult } from './lane-performance-business-logic';

export interface ForecastResult {
  inputsHash: string; seed: number; horizonEnd: string; iterations: number; scope: string; includedLanes: string[];
  p5: Figure; p25: Figure; p50: Figure; p75: Figure; p95: Figure;
  fan: { at: string; p5: Figure; p25: Figure; p50: Figure; p75: Figure; p95: Figure }[];
  pPositive: Figure; expectedMonthly: Figure; realisedMonthly: Figure; p95Drawdown30d: Figure;
  method: { name: string; blockSize: number; signalWindowDays: number; description: string };
}
const SOURCE = 'ladder_outcomes';
const DAY = 86_400_000;
const ITERATIONS = 2000;
const figure = (value: number | null, n: number, unit: Figure['unit'], source = SOURCE): Figure => ({ value, n, unit, source });

/** FNV-1a over canonical JSON. Inputs are already sorted by lane in the caller. */
export function stableInputsHash(value: unknown): string {
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function drawdown30Daily(values: number[]): number {
  let max = 0;
  for (let start = 0; start < values.length; start++) {
    let cumulative = 0; let high = 0;
    for (let day = start; day < Math.min(values.length, start + 30); day++) {
      cumulative += values[day];
      high = Math.max(high, cumulative);
      max = Math.max(max, high - cumulative);
    }
  }
  return max;
}

export function forecastLanes(lanes: LaneResult[], episodeUsd: Map<string, number[]>, now: string, horizonEnd: string, seed: number): ForecastResult {
  const live = lanes.filter((lane) => lane.kind === 'live' && lane.verdict !== 'KILL' &&
    lane.signalRatePerDay.n > 0 && (episodeUsd.get(lane.id)?.length ?? 0) > 0).sort((a, b) => a.id.localeCompare(b.id));
  const inputs = live.map((lane) => ({ id: lane.id, usd: episodeUsd.get(lane.id) ?? [],
    rate: lane.signalRatePerDay.value, episodes: lane.episodes, bar: lane.bar }));
  const realised = inputs.flatMap((lane) => lane.usd);
  const inputsHash = stableInputsHash({ inputs, realised, now, horizonEnd, seed, method: 2 });
  const days = Math.max(0, Math.ceil((Date.parse(`${horizonEnd.slice(0, 10)}T00:00:00Z`) - Date.parse(now)) / DAY));
  const simulationDays = Math.max(days, 30);
  const rng = mulberry32(seed);
  const totals: number[] = []; const drawdowns: number[] = [];
  const dailyTotals: number[][] = Array.from({ length: days }, () => []);
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const daily = Array.from({ length: simulationDays }, () => 0);
    for (const lane of inputs) {
      if (!lane.usd.length || !lane.rate) continue;
      // Resample adjacent pairs. A new pair starts after two sampled signals.
      let pair: [number, number] = [0, 0]; let pairIndex = 2;
      for (let day = 0; day < simulationDays; day++) {
        const expected = lane.rate;
        const whole = Math.floor(expected);
        const signals = whole + (rng() < expected - whole ? 1 : 0);
        for (let j = 0; j < signals; j++) {
          if (pairIndex >= 2) {
            const start = Math.floor(rng() * lane.usd.length);
            pair = [lane.usd[start], lane.usd[(start + 1) % lane.usd.length]];
            pairIndex = 0;
          }
          daily[day] += pair[pairIndex++];
        }
      }
    }
    let total = 0;
    daily.forEach((value, index) => { if (index < days) { total += value; dailyTotals[index].push(total); } });
    totals.push(total);
    drawdowns.push(drawdown30Daily(daily));
  }
  totals.sort((a, b) => a - b); drawdowns.sort((a, b) => a - b);
  const n = inputs.reduce((count, lane) => count + lane.usd.length, 0);
  const q = (p: number) => n && days ? percentile(totals, p) : null;
  const fan = dailyTotals.map((distribution, index) => {
    distribution.sort((a, b) => a - b);
    const at = new Date(Date.parse(now) + (index + 1) * DAY).toISOString().slice(0, 10);
    const point = (p: number) => figure(n ? percentile(distribution, p) : null, n, 'usd');
    return { at, p5: point(.05), p25: point(.25), p50: point(.5), p75: point(.75), p95: point(.95) };
  });
  return { inputsHash, seed, horizonEnd, iterations: ITERATIONS,
    scope: 'Live ladder lanes only; excludes KILLed lanes and lanes with no episodes in the last 90 days.',
    includedLanes: live.map((lane) => lane.id),
    fan,
    p5: figure(q(.05), n, 'usd'), p25: figure(q(.25), n, 'usd'), p50: figure(q(.5), n, 'usd'),
    p75: figure(q(.75), n, 'usd'), p95: figure(q(.95), n, 'usd'),
    pPositive: figure(n && days ? totals.filter((x) => x > 0).length / ITERATIONS : null, n, 'probability'),
    expectedMonthly: figure(n && days ? inputs.reduce((sum, lane) =>
      sum + lane.usd.reduce((a, b) => a + b, 0) / lane.usd.length * (lane.rate ?? 0) * 30, 0) : null, n, 'usd'),
    realisedMonthly: figure(realised.length ? realised.reduce((a, b) => a + b, 0) / 3 : null, realised.length, 'usd'),
    p95Drawdown30d: figure(n && days ? percentile(drawdowns, .95) : null, n, 'usd'),
    method: { name: 'seeded-episode-block-bootstrap', blockSize: 2, signalWindowDays: 90,
      description: 'Seeded 2-episode adjacent block bootstrap, 2,000 paths; sample realised USD per episode at the last 90-day episode rate. The monthly mean uses the observed episode rate and mean USD. Drawdown uses a full 30-day window.' } };
}
