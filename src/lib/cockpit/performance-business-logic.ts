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
  /** grossWin / grossLoss (∞-guarded → grossWin when no losses). */
  profitFactor: number;
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

  let pos: Position = emptyPosition(coin);
  for (const fill of chrono) {
    const prevSide = pos.side;
    pos = applyFill(pos, fill);
    const nowSide = pos.side;

    if (prevSide === 'flat' && nowSide !== 'flat') {
      // Opening a fresh exposure from flat.
      openSide = nowSide;
      openedAt = fill.filledAt;
      openIntentId = fill.clientIntentId;
      realizedBase = pos.realizedPnlUsd; // accumulators already include this fill's realized (0 on open)
      feesBase = pos.feesPaidUsd - fill.feeUsd;
      entryNotional = fill.px * fill.sz;
      entrySize = fill.sz;
    } else if (nowSide !== 'flat' && nowSide === prevSide) {
      // Adding to the same side — extend the entry VWAP basis.
      if (fill.side === (nowSide === 'long' ? 'buy' : 'sell')) {
        entryNotional += fill.px * fill.sz;
        entrySize += fill.sz;
      }
    }

    if (prevSide !== 'flat' && nowSide === 'flat' && openSide) {
      const realized = pos.realizedPnlUsd - realizedBase;
      const fees = pos.feesPaidUsd - feesBase;
      const entryPx = entrySize > 0 ? entryNotional / entrySize : fill.px;
      trades.push({
        id: openIntentId || `${coin}-${openedAt}`,
        openedAt,
        coin,
        side: openSide,
        sz: entrySize,
        entryPx,
        exitPx: fill.px,
        leverage: null,
        pnlUsd: realized,
        feesUsd: fees,
        status: realized >= 0 ? 'win' : 'loss',
        today: openedAt >= todayStartMs,
      });
      openSide = null;
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
): LedgerTrade[] {
  const todayStartMs = dayStart(nowMs);
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
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? grossWin : 0;
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

/** Worst peak-to-trough drawdown over an equity series, as a positive percent. */
export function maxDrawdown(equity: EquityPoint[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of equity) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = ((peak - p.equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

/**
 * Build a daily equity series ending at `currentEquity` (cash + unrealized).
 *
 * We reconstruct cash backwards from the current realized balance by removing
 * each closed trade's realized PnL (net of fee) as we step back in time. The
 * series spans the last `days` UTC days, one point per day, anchored to the
 * day each closed trade landed. Open positions' unrealized PnL is added to the
 * final point only (it isn't realized yet).
 */
export function buildEquitySeries(
  ledger: LedgerTrade[],
  currentEquity: number,
  nowMs: number,
  days = 30,
): EquityPoint[] {
  const closed = ledger
    .filter((t) => t.status !== 'open')
    .sort((a, b) => a.openedAt - b.openedAt);
  const todayBucket = dayStart(nowMs);
  const start = todayBucket - (days - 1) * 86_400_000;

  // Realized cash at each closed trade's open time, cumulative.
  const realizedCumByBucket = new Map<number, number>();
  let cum = 0;
  for (const t of closed) {
    cum += t.pnlUsd - t.feesUsd;
    realizedCumByBucket.set(dayStart(t.openedAt), cum);
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
