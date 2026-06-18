/**
 * Performance summary (I/O). Loads the durable `fills` ledger + `positions` for
 * a session and folds them (via the PURE performance-business-logic) into the
 * ledger / KPI / equity-series the Performance view renders.
 *
 * Marks: open positions are marked-to-market against the live HL mid (fetched
 * from the public HL info service — same transport the cockpit already uses).
 * Realized round-trips need no mark. Read-only; never writes.
 *
 * HONEST EQUITY (no fabricated baseline): paper mode has NO real account balance,
 * so we never invent a $50k anchor. `equityUsd` is the REAL absolute account value
 * — populated ONLY when a real balance is known (HL_ACCOUNT_EQUITY_USD env, set for
 * a live/funded account), else `null` → the UI shows "—". Everything else (net
 * P&L, today, fees, drawdown, the equity CURVE) is real derived data folded from
 * the immutable fills ledger; the curve is a cumulative P&L line anchored at 0 (or
 * at the real balance when known), never a made-up dollar level.
 */

import 'server-only';
import { getServiceRoleClient } from './supabase-server';
import { getActiveSession } from './session-service';
import { fillFromRow, type FillSelectRow } from './cockpit-rows-business-logic';
import {
  buildLedger,
  buildEquitySeries,
  computeKpis,
  type EquityPoint,
  type LedgerTrade,
  type MarkMap,
  type PerformanceKpis,
} from './performance-business-logic';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { CanonicalFill } from '@/types/fill';

/**
 * Operator timezone for the "Today" day boundary. The operator trades from
 * US/Eastern, so "Today" must reset at America/New_York midnight (NOT UTC
 * midnight, which lands mid-afternoon local). Override via HL_OPERATOR_TZ.
 */
function operatorTz(): string {
  return process.env.HL_OPERATOR_TZ?.trim() || 'America/New_York';
}

export interface PerformanceSummary {
  sessionId: string;
  ledger: LedgerTrade[];
  kpis: PerformanceKpis;
  /** Cumulative-PnL equity curve (anchored at the real balance when known, else 0). */
  equity: EquityPoint[];
  /**
   * REAL absolute account equity (cash + unrealized), or null when no real account
   * value is known (paper mode with no configured balance). NEVER a fabricated
   * anchor — the UI renders "—" when this is null.
   */
  equityUsd: number | null;
  /** Net realized + unrealized P&L (real, always known from the ledger). */
  netPnlUsd: number;
  /** 30-day equity change as a percent (vs the first point), or null when no real anchor. */
  equity30dPct: number | null;
  generatedAt: number;
}

const FILL_COLUMNS =
  'client_intent_id, session_id, coin, side, px, sz, notional_usd, fee_usd, reduce_only, partial, source, hl_order_id, hl_raw, filled_at';

/**
 * The REAL account balance anchor, or null when unknown. Set HL_ACCOUNT_EQUITY_USD
 * for a funded/live account so the absolute equity + % are shown; in paper mode
 * with no real account it stays null and we show "—" instead of inventing $50k.
 */
function realAccountBalance(): number | null {
  const env = Number(process.env.HL_ACCOUNT_EQUITY_USD ?? '');
  return Number.isFinite(env) && env > 0 ? env : null;
}

/**
 * Build the performance summary for a session. Fail-soft: on any I/O error the
 * caller gets an empty (flat) summary rather than a crash, so the view renders.
 */
export async function getPerformanceSummary(sessionId: string): Promise<PerformanceSummary> {
  const now = Date.now();
  const empty: PerformanceSummary = {
    sessionId,
    ledger: [],
    kpis: computeKpis([], {}, []),
    equity: [],
    equityUsd: realAccountBalance(),
    netPnlUsd: 0,
    equity30dPct: realAccountBalance() === null ? null : 0,
    generatedAt: now,
  };

  let fills: CanonicalFill[] = [];
  const leverageByCoin: Record<string, number | null> = {};
  try {
    const supabase = getServiceRoleClient();

    const { data: fillRows } = await supabase
      .from('fills')
      .select(FILL_COLUMNS)
      .eq('session_id', sessionId)
      .order('filled_at', { ascending: true })
      .limit(2000);
    fills = (fillRows ?? []).map((r) => fillFromRow(r as FillSelectRow));

    const { data: posRows } = await supabase
      .from('positions')
      .select('coin, leverage')
      .eq('session_id', sessionId);
    for (const row of posRows ?? []) {
      const r = row as { coin: string; leverage: number | null };
      leverageByCoin[r.coin.trim().toUpperCase()] = r.leverage ?? null;
    }
  } catch {
    return empty;
  }

  if (fills.length === 0) return empty;

  // Live marks for open positions (mark-to-market). Fail-soft to entry px.
  let marks: MarkMap = {};
  try {
    marks = await fetchAllMids();
  } catch {
    marks = {};
  }

  const ledger = buildLedger(fills, marks, now, leverageByCoin, operatorTz());
  const realized = ledger
    .filter((t) => t.status !== 'open')
    .reduce((s, t) => s + t.pnlUsd - t.feesUsd, 0);
  const openUnrealized = ledger
    .filter((t) => t.status === 'open')
    .reduce((s, t) => s + t.pnlUsd, 0);
  const netPnlUsd = realized + openUnrealized;

  // Anchor the curve at the REAL balance when known, else at 0 (a pure cumulative
  // P&L line). We never invent a $50k baseline. Absolute equity + % are real-only.
  const realBalance = realAccountBalance();
  const curveAnchor = (realBalance ?? 0) + netPnlUsd;
  const equity = buildEquitySeries(ledger, curveAnchor, now, 30);
  const kpis = computeKpis(ledger, marks, equity);
  const equityUsd = realBalance === null ? null : realBalance + netPnlUsd;
  const first = equity[0]?.equity ?? curveAnchor;
  const equity30dPct =
    realBalance === null || first <= 0 ? null : (curveAnchor / first - 1) * 100;

  return { sessionId, ledger, kpis, equity, equityUsd, netPnlUsd, equity30dPct, generatedAt: now };
}

/**
 * Result of resolving + folding the ACTIVE session's performance:
 *   - `ok`        : the active session matched (or no assertion was made).
 *   - `forbidden` : the caller asserted a `sessionId` that is NOT the active one.
 *   - `none`      : there is no active session at all.
 */
export type ActivePerformanceResult =
  | { status: 'ok'; summary: PerformanceSummary }
  | { status: 'forbidden' }
  | { status: 'none' };

/**
 * SECURITY boundary for the public performance route. The session is resolved
 * server-side via `getActiveSession()` — never taken from caller input. An
 * optional `requestedSessionId` is treated as an ASSERTION of which session the
 * caller expects: it must equal the active session, otherwise the request is
 * forbidden (a leaked/guessed/stale id cannot read another session's ledger).
 */
export async function getActivePerformanceSummary(
  requestedSessionId: string | null,
): Promise<ActivePerformanceResult> {
  const active = await getActiveSession();
  if (!active) return { status: 'none' };
  if (requestedSessionId && requestedSessionId !== active.id) {
    return { status: 'forbidden' };
  }
  const summary = await getPerformanceSummary(active.id);
  return { status: 'ok', summary };
}
