/**
 * PURE trader copyability fingerprint (fixture-testable) — the on-demand vetting
 * engine, extracted from scripts/_research-trader.ts and shaped to the persisted
 * `trader_evaluations` row (one-evaluation-two-consumers: the UI + the review-trader
 * skill read the same object).
 *
 * SCOPE (review A4): this is a SINGLE-WINDOW fingerprint. Its `verdict` certifies
 * OPERATIONAL FEASIBILITY — fillable, mirrorable hold, not a martingale/liquidation
 * tail — NOT forward profitability. A single window can look great by luck; the
 * small-live gate (Phase 4.5) is the only profit gate. `persistenceConfidence`
 * marks this honestly ('single-window'); the weekly Python re-rank is the
 * multi-window grade.
 */

import type { HlFill, HlClearinghouseState } from './hyperliquid-info-service';
import { buildCopyMonitorAnalytics } from './copy-monitor-analytics';

const EPS = 1e-9;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Below this many fills the read is too thin to grade confidently. */
export const MIN_FILLS = 50;

export type Verdict = 'follow' | 'caution' | 'avoid';
export type PersistenceConfidence = 'multi-window' | 'single-window' | 'insufficient';

export interface FingerprintMetrics {
  nFills: number;
  roundTrips: number;
  winRate: number | null;
  profitFactor: number | null;
  realizedPnlUsd: number;
  medianHoldHours: number | null;
  intradayFrac: number | null;
  worstLossVsMedianWin: number | null;
  maxDrawdownFrac: number | null;
  distinctCoins: number;
  top3Share: number | null;
  addsPerTrip: number | null;
  liquidations: number;
  activeDayFrac: number | null;
}

export interface TraderFingerprint {
  metrics: FingerprintMetrics;
  verdict: Verdict;
  persistenceConfidence: PersistenceConfidence;
  /** Hold-time distribution (hours) — replaces the misleading single median. */
  holdDistribution: { p10: number; p50: number; p90: number } | null;
  /** Per-coin round-trip counts + realized pnl, most-traded first (top 8). */
  roundTripSeries: Array<{ coin: string; trips: number; pnlUsd: number }>;
  fillsSeen: number;
  windowDays: number;
  /** Human reason behind the verdict (the *why*, surfaced in the UI + skill). */
  why: string;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}

interface RoundTrip { coin: string; openTime: number; closeTime: number; holdMs: number; pnl: number; }

/** Reconstruct round-trips per coin by tracking signed running size across fills. PURE. */
export function reconstructRoundTrips(fills: HlFill[]): RoundTrip[] {
  const byCoin = new Map<string, HlFill[]>();
  for (const f of fills) {
    if (!byCoin.has(f.coin)) byCoin.set(f.coin, []);
    byCoin.get(f.coin)!.push(f);
  }
  const trips: RoundTrip[] = [];
  for (const [coin, fs] of byCoin) {
    fs.sort((a, b) => a.time - b.time);
    let pos = 0, openTime = 0, pnlAccum = 0;
    for (const f of fs) {
      const delta = f.side === 'buy' ? f.sz : -f.sz;
      if (Math.abs(pos) < EPS && Math.abs(delta) > EPS) openTime = f.time;
      pnlAccum += f.closedPnl ?? 0;
      const prev = pos;
      pos += delta;
      const crossedZero = Math.abs(pos) < EPS || prev * pos < 0;
      if (crossedZero && openTime > 0) {
        trips.push({ coin, openTime, closeTime: f.time, holdMs: f.time - openTime, pnl: pnlAccum });
        pnlAccum = 0;
        openTime = Math.abs(pos) > EPS ? f.time : 0;
      }
    }
  }
  return trips;
}

/** Compute the copyability fingerprint from a fill history + live clearinghouse. PURE. */
export function computeTraderFingerprint(
  fills: HlFill[],
  state: HlClearinghouseState,
  windowDays: number,
): TraderFingerprint {
  const nFills = fills.length;
  const trips = reconstructRoundTrips(fills);
  const wins = trips.filter((t) => t.pnl > 0);
  const losses = trips.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? Infinity : null;
  const medWin = wins.length ? median(wins.map((t) => t.pnl)) : 0;
  const worstLoss = losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0;
  const holds = trips.map((t) => t.holdMs);
  const medHoldMs = median(holds);
  const intraday = trips.filter((t) => t.holdMs < DAY).length;
  const realizedPnlUsd = fills.reduce((s, f) => s + (f.closedPnl ?? 0), 0);

  // per-coin series + concentration
  const byCoin = new Map<string, { n: number; pnl: number }>();
  for (const t of trips) {
    const e = byCoin.get(t.coin) ?? { n: 0, pnl: 0 };
    e.n += 1; e.pnl += t.pnl;
    byCoin.set(t.coin, e);
  }
  const ranked = [...byCoin.entries()].sort((a, b) => b[1].n - a[1].n);
  const top3Share = trips.length ? ranked.slice(0, 3).reduce((s, [, e]) => s + e.n, 0) / trips.length : null;

  // realized-PnL drawdown
  const ordered = [...trips].sort((a, b) => a.closeTime - b.closeTime);
  let cum = 0, peak = 0, maxDd = 0;
  for (const t of ordered) { cum += t.pnl; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum); }
  const maxDrawdownFrac = peak > 0 ? maxDd / peak : null;

  const liquidations = fills.filter((f) => /liquidat/i.test(f.dir ?? '')).length;
  const totalAdds = buildCopyMonitorAnalytics(null, state, fills).totalAdds;
  const addsPerTrip = trips.length ? totalAdds / trips.length : null;
  const worstLossVsMedianWin = medWin > 0 ? Math.abs(worstLoss) / medWin : null;

  const dayKeys = new Set(fills.map((f) => Math.floor(f.time / DAY)));
  const spanDays = nFills ? Math.max(1, Math.round((Math.max(...fills.map((f) => f.time)) - Math.min(...fills.map((f) => f.time))) / DAY)) : 1;
  const activeDayFrac = dayKeys.size / spanDays;

  const metrics: FingerprintMetrics = {
    nFills,
    roundTrips: trips.length,
    winRate: trips.length ? wins.length / trips.length : null,
    profitFactor: profitFactor === Infinity ? 999 : profitFactor,
    realizedPnlUsd,
    medianHoldHours: holds.length ? medHoldMs / HOUR : null,
    intradayFrac: trips.length ? intraday / trips.length : null,
    worstLossVsMedianWin,
    maxDrawdownFrac,
    distinctCoins: byCoin.size,
    top3Share,
    addsPerTrip,
    liquidations,
    activeDayFrac,
  };

  // --- Verdict: OPERATIONAL FEASIBILITY (copyable-with-a-stop), not profit (A4) ---
  let verdict: Verdict;
  let why: string;
  let persistenceConfidence: PersistenceConfidence;

  if (nFills < MIN_FILLS) {
    verdict = 'caution';
    persistenceConfidence = 'insufficient';
    why = `Only ${nFills} fills in ${windowDays}d — too thin to grade.`;
  } else {
    persistenceConfidence = 'single-window';
    const avoidReasons: string[] = [];
    if (liquidations > 0) avoidReasons.push(`${liquidations} liquidation fill(s)`);
    if (addsPerTrip != null && addsPerTrip > 3) avoidReasons.push(`averages down hard (${addsPerTrip.toFixed(1)} adds/trip)`);
    if (worstLossVsMedianWin != null && worstLossVsMedianWin > 6) avoidReasons.push(`one-big-loss shape (worst/median-win ${worstLossVsMedianWin.toFixed(1)}×)`);
    if (avoidReasons.length > 0) {
      verdict = 'avoid';
      why = `Uncopyable with a stop: ${avoidReasons.join('; ')}.`;
    } else {
      const cautionReasons: string[] = [];
      if (metrics.medianHoldHours != null && metrics.medianHoldHours > 72) cautionReasons.push('multi-day holds (hard to mirror)');
      if (top3Share != null && top3Share < 0.4) cautionReasons.push('spread across many coins');
      if (metrics.winRate != null && metrics.winRate < 0.4) cautionReasons.push(`low win rate (${(metrics.winRate * 100).toFixed(0)}%)`);
      if (cautionReasons.length > 0) {
        verdict = 'caution';
        why = `Operationally watch-out: ${cautionReasons.join('; ')}.`;
      } else {
        verdict = 'follow';
        why = `Clean copyable shape: no liqs, cuts losers, ${metrics.medianHoldHours != null ? `~${metrics.medianHoldHours.toFixed(0)}h holds, ` : ''}concentrated. (Feasibility, not a profit guarantee.)`;
      }
    }
  }

  return {
    metrics,
    verdict,
    persistenceConfidence,
    holdDistribution: holds.length ? { p10: percentile(holds, 10) / HOUR, p50: medHoldMs / HOUR, p90: percentile(holds, 90) / HOUR } : null,
    roundTripSeries: ranked.slice(0, 8).map(([coin, e]) => ({ coin, trips: e.n, pnlUsd: e.pnl })),
    fillsSeen: nFills,
    windowDays,
    why,
  };
}
