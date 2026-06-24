/**
 * Performance derivation (PURE — no I/O, no clock, no env).
 *
 * The Performance view (design handoff) shows a KPI strip, a 30-day equity
 * curve, and a trade ledger. None of that is a stored artifact — it is DERIVED
 * from the durable `fills` ledger (the single source of truth, ADR-0001) plus
 * the live positions/marks. This module folds the fill ledger into:
 *
 *   - `LedgerTrade[]`   — one row per realized round-trip (closed) + one per
 *                         still-open position (mark-to-market), newest first.
 *   - `PerformanceKpis` — Net PnL, win rate, profit factor, today, avg trade,
 *                         max drawdown, fees, open exposure.
 *   - `EquityPoint[]`   — a daily equity series for the 30-day chart.
 *
 * It is intentionally venue-faithful but simple: realized P&L comes from the
 * canonical position fold (`applyFills`), and open rows mark-to-market against
 * the supplied live mark. Every metric is documented so the UI never computes —
 * it only renders (money math lives here, not in components).
 *
 * Fully deterministic and fixture-testable.
 */

import type { CanonicalFill } from '@/types/fill';
import type { Position } from '@/types/position';
import { applyFill, emptyPosition } from '@/lib/trading/pnl-business-logic';

/** Trade status as rendered by the ledger (design: OPEN / WIN / LOSS). */
export type LedgerStatus = 'open' | 'win' | 'loss';

/** A single ledger row — a realized round-trip or a still-open position. */
export interface LedgerTrade {
  /** Stable id (the opening fill's client_intent_id, or `${coin}-open`). */
  id: string;
  /** Epoch ms of the opening fill (sort key). */
  openedAt: number;
  /**
   * Epoch ms of the closing fill (the flat/flip boundary). Null for still-open
   * rows. Realized PnL is *earned* at this instant, so the equity curve buckets
   * on `closedAt` (a trade opened day 1 / closed day 20 lands on day 20).
   */
  closedAt: number | null;
  coin: string;
  /** Position direction over the trade's life. */
  side: 'long' | 'short';
  /** Closed size (abs coin units). For an open row this is the live size. */
  sz: number;
  /** Volume-weighted average entry price. */
  entryPx: number;
  /** Exit/close price for closed trades; live mark for open rows. */
  exitPx: number | null;
  /** Opening leverage if known (metadata only — does not affect PnL). */
  leverage: number | null;
  /** Realized PnL for closed trades; live unrealized PnL for open rows. */
  pnlUsd: number;
  /** Fees attributed to this trade. */
  feesUsd: number;
  status: LedgerStatus;
  /** True when the trade opened within the "today" window. */
  today: boolean;
}

export interface PerformanceKpis {
  /** Σ realized PnL over closed trades. */
  netPnlUsd: number;
  /** Number of closed (realized) trades. */
  closedCount: number;
  /** Wins / closed × 100. */
  winRatePct: number;
  winCount: number;
  lossCount: number;
  /**
   * grossWin / grossLoss. `Infinity` when there are wins but no losses
   * (rendered "∞"), `null` when there are no closed trades at all. A finite
   * ratio otherwise. NEVER a dollar figure masquerading as a ratio.
   */
  profitFactor: number | null;
  /** Σ realized PnL over closed trades opened today. */
  todayPnlUsd: number;
  /** netPnl / closedCount (0 when none). */
  avgTradeUsd: number;
  /** Worst peak-to-trough drawdown over the equity series, as a positive %. */
  maxDrawdownPct: number;
  /** Σ fees over closed trades. */
  feesUsd: number;
  /** Σ |mark × size| over open positions. */
  openExposureUsd: number;
  openCount: number;
}

export interface EquityPoint {
  /** Epoch ms (day bucket). */
  t: number;
  /** Equity (cash + unrealized) at that point. */
  equity: number;
}

/** Live mark for a coin (for marking open positions to market). */
export type MarkMap = Record<string, number | null | undefined>;

/** Day bucket (UTC midnight) for an epoch-ms timestamp. */
function dayStart(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

/**
 * Resolve the start-of-day epoch ms for `ms` in a given IANA timezone (default
 * UTC). The "Today" KPI must reset at the OPERATOR's local midnight, not UTC
 * midnight — the operator is US/Eastern, where UTC midnight falls mid-afternoon,
 * so a naive UTC floor resets "Today" at ~19:00–20:00 local. We compute the
 * timezone's UTC offset at the instant via `Intl` (DST-correct) and floor in
 * local space. Deterministic: depends only on `ms` + `tz`, no ambient clock.
 */
export function localDayStart(ms: number, tz = 'UTC'): number {
  if (tz === 'UTC') return dayStart(ms);
  const offsetMs = tzOffsetMs(ms, tz);
  // Shift into local wall-clock space, floor to local midnight, shift back.
  return Math.floor((ms + offsetMs) / 86_400_000) * 86_400_000 - offsetMs;
}

/** UTC offset (ms, +east) of `tz` at instant `ms`, via Intl (DST-correct). */
function tzOffsetMs(ms: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  // The wall-clock components in `tz`, interpreted as if they were UTC.
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Fold the fill ledger for ONE coin into a per-coin realized + open summary.
 * We reconstruct round-trips by walking fills in chronological order: whenever
 * the running position returns to flat (or flips), the realized PnL accumulated
 * since the last flat boundary closes a `LedgerTrade`. A residual open position
 * becomes a single mark-to-market open row.
 */
function tradesForCoin(
  coin: string,
  fills: CanonicalFill[],
  mark: number | null | undefined,
  todayStartMs: number,
): LedgerTrade[] {
  const chrono = [...fills].sort((a, b) => a.filledAt - b.filledAt);
  const trades: LedgerTrade[] = [];

  // Running round-trip accumulators. A round-trip opens when the position leaves
  // flat and closes when it returns to flat; realized PnL/fees are measured as
  // the delta of the running position's accumulators across that boundary.
  let openSide: 'long' | 'short' | null = null;
  let openedAt = 0;
  let openIntentId = '';
  let realizedBase = 0;
  let feesBase = 0;
  let entryNotional = 0;
  let entrySize = 0;

  // Begin a fresh round-trip from the side the position now holds. The opening
  // fill's px/sz seed the entry VWAP basis (for a flip, this is the OVERSHOOT
  // size that survived past flat, priced at the fill px — matching applyFill).
  function openRoundTrip(fill: CanonicalFill, side: 'long' | 'short', basisSz: number, realizedNow: number, feesBaseNow: number): void {
    openSide = side;
    openedAt = fill.filledAt;
    openIntentId = fill.clientIntentId;
    realizedBase = realizedNow;
    feesBase = feesBaseNow;
    entryNotional = fill.px * basisSz;
    entrySize = basisSz;
  }

  // Close the running round-trip at `fill` and push the realized LedgerTrade.
  function closeRoundTrip(fill: CanonicalFill, realizedNow: number, feesNow: number): void {
    if (!openSide) return;
    const realized = realizedNow - realizedBase;
    const fees = feesNow - feesBase;
    const entryPx = entrySize > 0 ? entryNotional / entrySize : fill.px;
    trades.push({
      id: openIntentId || `${coin}-${openedAt}`,
      openedAt,
      closedAt: fill.filledAt,
      coin,
      side: openSide,
      sz: entrySize,
      entryPx,
      exitPx: fill.px,
      leverage: null,
      pnlUsd: realized,
      feesUsd: fees,
      status: realized >= 0 ? 'win' : 'loss',
      today: fill.filledAt >= todayStartMs,
    });
    openSide = null;
  }

  let pos: Position = emptyPosition(coin);
  for (const fill of chrono) {
    const prevSide = pos.side;
    const feesBeforeFill = pos.feesPaidUsd;
    pos = applyFill(pos, fill);
    const nowSide = pos.side;

    if (prevSide === 'flat' && nowSide !== 'flat') {
      // Opening a fresh exposure from flat. Fee base excludes this opening fee.
      openRoundTrip(fill, nowSide, fill.sz, pos.realizedPnlUsd, feesBeforeFill);
    } else if (nowSide !== 'flat' && nowSide === prevSide) {
      // Adding to / reducing the same side. Extend the entry VWAP basis only on
      // a same-direction add (a partial reduce keeps the basis intact).
      if (fill.side === (nowSide === 'long' ? 'buy' : 'sell')) {
        entryNotional += fill.px * fill.sz;
        entrySize += fill.sz;
      }
    } else if (prevSide !== 'flat' && nowSide === 'flat') {
      // Returned to flat — close the round-trip at this fill.
      closeRoundTrip(fill, pos.realizedPnlUsd, pos.feesPaidUsd);
    } else if (prevSide !== 'flat' && nowSide !== 'flat' && nowSide !== prevSide) {
      // DIRECT FLIP (long↔short without passing through flat). applyFill already
      // realized the close of the OLD side and reopened the overshoot at fill px.
      // Treat it as close-old-then-open-new so the realized PnL is captured in a
      // closed LedgerTrade (otherwise it is silently dropped → undercounts).
      // The flip fee belongs to the close (it's the fee that flattened the old
      // side); the new side opens with zero attributed fee until its own fills.
      closeRoundTrip(fill, pos.realizedPnlUsd, pos.feesPaidUsd);
      // Overshoot size that survived past flat seeds the new side's basis.
      openRoundTrip(fill, nowSide, pos.sz, pos.realizedPnlUsd, pos.feesPaidUsd);
    }
  }

  // Residual open position → one mark-to-market open row.
  if (pos.side !== 'flat' && openSide) {
    const dir = pos.side === 'long' ? 1 : -1;
    const m = mark ?? pos.avgEntryPx;
    const unrealized = (m - pos.avgEntryPx) * pos.sz * dir;
    trades.push({
      id: `${coin}-open`,
      openedAt,
      closedAt: null,
      coin,
      side: pos.side,
      sz: pos.sz,
      entryPx: pos.avgEntryPx,
      exitPx: mark ?? null,
      leverage: null,
      pnlUsd: unrealized,
      feesUsd: pos.feesPaidUsd - feesBase,
      status: 'open',
      today: openedAt >= todayStartMs,
    });
  }

  return trades;
}

/**
 * Build the full ledger (closed round-trips + open rows) from ALL fills across
 * coins, newest-first. `leverageByCoin` lets the caller attach opening leverage
 * (from the positions table) to the open rows.
 */
export function buildLedger(
  fills: CanonicalFill[],
  marks: MarkMap,
  nowMs: number,
  leverageByCoin: Record<string, number | null> = {},
  /** IANA tz for the "today" window (operator-local). Default UTC. */
  tz = 'UTC',
): LedgerTrade[] {
  const todayStartMs = localDayStart(nowMs, tz);
  const byCoin = new Map<string, CanonicalFill[]>();
  for (const f of fills) {
    const arr = byCoin.get(f.coin) ?? [];
    arr.push(f);
    byCoin.set(f.coin, arr);
  }
  const out: LedgerTrade[] = [];
  for (const [coin, coinFills] of byCoin) {
    for (const t of tradesForCoin(coin, coinFills, marks[coin], todayStartMs)) {
      const lev = t.status === 'open' ? leverageByCoin[coin] ?? null : t.leverage;
      out.push({ ...t, leverage: lev });
    }
  }
  return out.sort((a, b) => b.openedAt - a.openedAt);
}

/** Derive the KPI strip from a built ledger + live marks. */
export function computeKpis(
  ledger: LedgerTrade[],
  marks: MarkMap,
  equity: EquityPoint[],
): PerformanceKpis {
  const closed = ledger.filter((t) => t.status !== 'open');
  const wins = closed.filter((t) => t.status === 'win');
  const losses = closed.filter((t) => t.status === 'loss');
  const open = ledger.filter((t) => t.status === 'open');

  const netPnlUsd = closed.reduce((s, t) => s + t.pnlUsd, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  // Profit factor = grossWin / grossLoss. NEVER a dollar figure as a ratio:
  //   - no closed trades      → null (nothing to rate)
  //   - wins but no losses    → Infinity (rendered "∞")
  //   - otherwise             → the finite ratio.
  const profitFactor =
    closed.length === 0 ? null : grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const todayPnlUsd = closed.filter((t) => t.today).reduce((s, t) => s + t.pnlUsd, 0);
  const feesUsd = closed.reduce((s, t) => s + t.feesUsd, 0);
  const openExposureUsd = open.reduce((s, t) => {
    const m = marks[t.coin] ?? t.entryPx;
    return s + Math.abs(m * t.sz);
  }, 0);

  return {
    netPnlUsd,
    closedCount: closed.length,
    winRatePct: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
    winCount: wins.length,
    lossCount: losses.length,
    profitFactor,
    todayPnlUsd,
    avgTradeUsd: closed.length > 0 ? netPnlUsd / closed.length : 0,
    maxDrawdownPct: maxDrawdown(equity),
    feesUsd,
    openExposureUsd,
    openCount: open.length,
  };
}

/**
 * Worst peak-to-trough drawdown over an equity series, as a positive percent.
 *
 * Clamped to [0, 100]: a decline can't sanely exceed 100% of the peak unless the
 * equity baseline crossed zero — which only happens when the curve is anchored at
 * ~0 (a cumulative-P&L line with no real balance). The real fix is anchoring at
 * live equity; this clamp is a safety net so a degenerate baseline can never
 * render an absurd "-10149%". When properly anchored at real equity it never bites.
 */
export function maxDrawdown(equity: EquityPoint[]): number {
  // A series that touches/crosses <= 0 has a DEGENERATE baseline (it's a
  // cumulative-P&L line anchored at ~0, not a real-equity curve) — peak-to-trough
  // % is meaningless there (it's what produced "-10149%"). Don't fabricate a
  // number; report 0 (the card already shows "Cumulative P&L", not "Account
  // Equity", in that state). A real-equity-anchored curve stays positive.
  if (equity.length === 0 || equity.some((p) => p.equity <= 0)) return 0;
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of equity) {
    if (p.equity > peak) peak = p.equity;
    const dd = ((peak - p.equity) / peak) * 100; // peak > 0 guaranteed (all > 0)
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/**
 * Build a daily equity series ending at `currentEquity` (cash + unrealized).
 *
 * We reconstruct cash backwards from the current realized balance by removing
 * each closed trade's realized PnL (net of fee) as we step back in time. The
 * series spans the last `days` UTC days, one point per day, anchored to the day
 * each closed trade *closed* (realized PnL is earned at the flat/flip boundary —
 * a trade opened day 1 / closed day 20 lands on day 20, so the curve and the
 * max-drawdown KPI take the correct shape). Open positions' unrealized PnL is
 * added to the final point only (it isn't realized yet).
 */
export function buildEquitySeries(
  ledger: LedgerTrade[],
  currentEquity: number,
  nowMs: number,
  days = 30,
): EquityPoint[] {
  const closed = ledger
    .filter((t) => t.status !== 'open')
    .sort((a, b) => (a.closedAt ?? a.openedAt) - (b.closedAt ?? b.openedAt));
  const todayBucket = dayStart(nowMs);
  const start = todayBucket - (days - 1) * 86_400_000;

  // Realized cash at each closed trade's CLOSE time, cumulative.
  const realizedCumByBucket = new Map<number, number>();
  let cum = 0;
  for (const t of closed) {
    cum += t.pnlUsd - t.feesUsd;
    realizedCumByBucket.set(dayStart(t.closedAt ?? t.openedAt), cum);
  }
  const totalRealized = cum;

  // Anchor the series so the last point equals currentEquity exactly:
  //   equity(day d) = currentEquity − (totalRealized − realizedCumUpTo(d)).
  // We carry the most-recent cumulative realized forward across empty days.
  const sortedBuckets = [...realizedCumByBucket.entries()].sort((a, b) => a[0] - b[0]);
  const points: EquityPoint[] = [];
  for (let d = start; d <= todayBucket; d += 86_400_000) {
    let cumUpToDay = 0;
    for (const [bucket, val] of sortedBuckets) {
      if (bucket <= d) cumUpToDay = val;
      else break;
    }
    points.push({ t: d, equity: currentEquity - (totalRealized - cumUpToDay) });
  }
  // Guarantee the final point is the live equity.
  if (points.length > 0) points[points.length - 1].equity = currentEquity;
  return points;
}
