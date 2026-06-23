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
import { fetchAllMids, fetchClearinghouseState, isValidHlAddress } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { CanonicalFill, TradingMode } from '@/types/fill';

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
 * The REAL starting-balance anchor for the equity CURVE, or null when unknown.
 * Static env (HL_ACCOUNT_EQUITY_USD); used to anchor the 30d series. Live current
 * equity is resolved separately (fetchLiveAccountValue) — don't conflate them.
 */
function realAccountBalance(): number | null {
  const env = Number(process.env.HL_ACCOUNT_EQUITY_USD ?? '');
  return Number.isFinite(env) && env > 0 ? env : null;
}

/**
 * The LIVE current account equity from HL, or null. When HL_ACCOUNT_ADDRESS is set
 * (the public master account), read clearinghouseState.accountValueUsd — the real
 * total equity right now (cash + unrealized). This is what fills the "Account
 * Equity" card with the actual balance instead of "—". Fail-soft → null (card
 * falls back to env-anchored cumulative P&L). accountValueUsd already includes open
 * uPnL, so it's shown DIRECTLY, never added to netPnlUsd.
 */
async function fetchLiveAccountValue(): Promise<number | null> {
  const addr = process.env.HL_ACCOUNT_ADDRESS?.trim();
  if (!addr || !isValidHlAddress(addr)) return null;
  try {
    const ch = await fetchClearinghouseState(addr);
    if (ch.stale) return null;
    // >= 0 (not > 0): a real, reachable account that is currently flat should show
    // "$0.00", not "—". "—" is reserved for UNKNOWN (no address / stale / error).
    return Number.isFinite(ch.accountValueUsd) && ch.accountValueUsd >= 0 ? ch.accountValueUsd : null;
  } catch {
    return null;
  }
}

/**
 * Build the performance summary for a session. Fail-soft: on any I/O error the
 * caller gets an empty (flat) summary rather than a crash, so the view renders.
 */
export async function getPerformanceSummary(sessionId: string): Promise<PerformanceSummary> {
  const now = Date.now();
  // Live HL equity (real balance) takes precedence over the static env anchor for
  // the displayed value. Resolved once, fail-soft. Even with no trades this lets a
  // funded account show its real balance instead of "—".
  const liveEquityUsd = await fetchLiveAccountValue();
  const emptyEquityUsd = liveEquityUsd ?? realAccountBalance();
  const empty: PerformanceSummary = {
    sessionId,
    ledger: [],
    kpis: computeKpis([], {}, []),
    equity: [],
    equityUsd: emptyEquityUsd,
    netPnlUsd: 0,
    equity30dPct: emptyEquityUsd === null ? null : 0,
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
  // Card value: prefer the LIVE account equity (already includes open uPnL — shown
  // directly), else the env-anchored cumulative (start balance + netPnl).
  const equityUsd = liveEquityUsd ?? (realBalance === null ? null : realBalance + netPnlUsd);
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
/**
 * ACCOUNT-WIDE performance for a trading mode — folds the fills from ALL sessions of
 * that mode (not one session) into the ledger/KPIs/equity, plus the live account
 * equity. This is what the Performance tab shows: the operator's WHOLE live history,
 * so opening/closing sessions never hides past orders (the "Performance got reset"
 * bug). Single-operator + admin-authed, so there's no cross-session leak to guard.
 */
export async function getAccountPerformanceSummary(mode: TradingMode): Promise<PerformanceSummary> {
  const now = Date.now();
  const liveEquityUsd = await fetchLiveAccountValue();
  const realBalance = realAccountBalance();
  const empty: PerformanceSummary = {
    sessionId: '',
    ledger: [],
    kpis: computeKpis([], {}, []),
    equity: [],
    equityUsd: liveEquityUsd ?? realBalance,
    netPnlUsd: 0,
    equity30dPct: (liveEquityUsd ?? realBalance) === null ? null : 0,
    generatedAt: now,
  };

  let fills: CanonicalFill[] = [];
  const leverageByCoin: Record<string, number | null> = {};
  try {
    const supabase = getServiceRoleClient();
    const { data: sessRows } = await supabase.from('sessions').select('id').eq('mode', mode);
    const ids = (sessRows ?? []).map((r) => (r as { id: string }).id);
    if (ids.length === 0) return empty;
    const { data: fillRows } = await supabase
      .from('fills')
      .select(FILL_COLUMNS)
      .in('session_id', ids)
      .order('filled_at', { ascending: true })
      .limit(5000);
    fills = (fillRows ?? []).map((r) => fillFromRow(r as FillSelectRow));
    const { data: posRows } = await supabase.from('positions').select('coin, leverage').in('session_id', ids);
    for (const row of posRows ?? []) {
      const r = row as { coin: string; leverage: number | null };
      leverageByCoin[r.coin.trim().toUpperCase()] = r.leverage ?? null;
    }
  } catch {
    return empty;
  }

  if (fills.length === 0) return empty;

  let marks: MarkMap = {};
  try {
    marks = await fetchAllMids();
  } catch {
    marks = {};
  }

  const ledger = buildLedger(fills, marks, now, leverageByCoin, operatorTz());
  const realized = ledger.filter((t) => t.status !== 'open').reduce((s, t) => s + t.pnlUsd - t.feesUsd, 0);
  const openUnrealized = ledger.filter((t) => t.status === 'open').reduce((s, t) => s + t.pnlUsd, 0);
  const netPnlUsd = realized + openUnrealized;
  const curveAnchor = (realBalance ?? 0) + netPnlUsd;
  const equity = buildEquitySeries(ledger, curveAnchor, now, 30);
  const kpis = computeKpis(ledger, marks, equity);
  const equityUsd = liveEquityUsd ?? (realBalance === null ? null : realBalance + netPnlUsd);
  const first = equity[0]?.equity ?? curveAnchor;
  const equity30dPct = realBalance === null || first <= 0 ? null : (curveAnchor / first - 1) * 100;

  return { sessionId: '', ledger, kpis, equity, equityUsd, netPnlUsd, equity30dPct, generatedAt: now };
}

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
