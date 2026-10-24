/** Pure, read-only OI direction study over completed htf replay trades. */
import type { ReplayTrade } from './htf-replay-business-logic';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EPISODE = 5 * DAY;
const MAX_AGE = 6 * HOUR;

export interface OiSnapshot { coin: string; time: number; openInterest: number | null }
export interface OiCohort { n: number; episodes: number; meanNetR: number | null; winners: number }
export interface OiDirectionReport {
  coverage: { total: number; eligible: number; rising: number; falling: number;
    flat: number; stale: number; missing: number };
  eligible: OiCohort;
  rising: OiCohort;
  falling: OiCohort;
  winnerRetention: number | null;
  excludedCoverage: number;
  verdict: 'insufficient_evidence' | 'kill' | 'keep_for_research';
}

function cohort(trades: ReplayTrade[]): OiCohort {
  const first = Math.min(...trades.map((trade) => trade.entryTime));
  return { n: trades.length,
    episodes: new Set(trades.map((trade) => Math.floor((trade.entryTime - first) / EPISODE))).size,
    meanNetR: trades.length ? trades.reduce((sum, trade) => sum + trade.netR, 0) / trades.length : null,
    winners: trades.filter((trade) => trade.netR > 0).length };
}

function latestBefore(points: OiSnapshot[], time: number): OiSnapshot | undefined {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].time < time) return points[i];
  }
  return undefined;
}

/** Signal close equals the next daily open timestamp. Exact-time snapshots are excluded. */
export function assessOiDirection(trades: ReplayTrade[], snapshots: OiSnapshot[]): OiDirectionReport {
  for (const point of snapshots) {
    if (!point.coin || !Number.isFinite(point.time) ||
      (point.openInterest !== null && (!Number.isFinite(point.openInterest) || point.openInterest <= 0))) {
      throw new Error('Invalid OI snapshot');
    }
  }
  for (const trade of trades) {
    if (!trade.coin || !Number.isFinite(trade.entryTime) || !Number.isFinite(trade.netR)) {
      throw new Error('Invalid replay trade');
    }
  }
  const byCoin = new Map<string, OiSnapshot[]>();
  for (const point of snapshots) {
    const rows = byCoin.get(point.coin) ?? [];
    rows.push(point);
    byCoin.set(point.coin, rows);
  }
  for (const rows of byCoin.values()) rows.sort((a, b) => a.time - b.time);
  const rising: ReplayTrade[] = [];
  const falling: ReplayTrade[] = [];
  let flat = 0;
  let stale = 0;
  let missing = 0;
  for (const trade of trades) {
    const points = byCoin.get(trade.coin) ?? [];
    const recent = latestBefore(points, trade.entryTime);
    // The earlier measurement must precede the latest one by a full day.
    const previous = recent ? latestBefore(points, recent.time - DAY + 1) : undefined;
    if (!recent || !previous || recent.openInterest === null || previous.openInterest === null) {
      missing++;
    } else if (trade.entryTime - recent.time > MAX_AGE ||
      trade.entryTime - DAY - previous.time > MAX_AGE) {
      stale++;
    } else if (recent.openInterest > previous.openInterest) rising.push(trade);
    else if (recent.openInterest < previous.openInterest) falling.push(trade);
    else flat++;
  }
  const eligible = [...rising, ...falling];
  const eligibleSummary = cohort(eligible);
  const risingSummary = cohort(rising);
  const winnerRetention = eligibleSummary.winners ? risingSummary.winners / eligibleSummary.winners : null;
  const verdict = rising.length < 20 ? 'insufficient_evidence'
    : (risingSummary.meanNetR ?? -Infinity) < 0.2 ||
      (winnerRetention !== null && winnerRetention < 0.5) ? 'kill' : 'keep_for_research';
  return { coverage: { total: trades.length, eligible: eligible.length, rising: rising.length,
    falling: falling.length, flat, stale, missing }, eligible: eligibleSummary,
  rising: risingSummary, falling: cohort(falling), winnerRetention,
  excludedCoverage: trades.length ? (flat + stale + missing) / trades.length : 0, verdict };
}
