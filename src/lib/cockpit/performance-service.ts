/**
 * Performance summary (I/O). Loads the durable `fills` ledger + `positions` for
 * a session and folds them (via the PURE performance-business-logic) into the
 * ledger / KPI / equity-series the Performance view renders.
 *
 * Marks: open positions are marked-to-market against the live HL mid (fetched
 * from the public HL info service — same transport the cockpit already uses).
 * Realized round-trips need no mark. Read-only; never writes.
 *
 * The baseline cash (starting balance) is read from env (HL_PAPER_BALANCE,
 * default 50_000) so the equity curve has an absolute anchor; only the SHAPE
 * (drawdown, today, deltas) is derived data — the absolute level is informational.
 */

import 'server-only';
import { getServiceRoleClient } from './supabase-server';
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

export interface PerformanceSummary {
  sessionId: string;
  ledger: LedgerTrade[];
  kpis: PerformanceKpis;
  equity: EquityPoint[];
  /** Current equity = baseline cash + realized + open unrealized. */
  equityUsd: number;
  /** 30-day equity change as a percent (vs the first point). */
  equity30dPct: number;
  generatedAt: number;
}

const FILL_COLUMNS =
  'client_intent_id, session_id, coin, side, px, sz, notional_usd, fee_usd, reduce_only, partial, source, hl_order_id, hl_raw, filled_at';

function baselineCash(): number {
  const env = Number(process.env.HL_PAPER_BALANCE ?? '');
  return Number.isFinite(env) && env > 0 ? env : 50_000;
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
    equityUsd: baselineCash(),
    equity30dPct: 0,
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

  const ledger = buildLedger(fills, marks, now, leverageByCoin);
  const realized = ledger
    .filter((t) => t.status !== 'open')
    .reduce((s, t) => s + t.pnlUsd - t.feesUsd, 0);
  const openUnrealized = ledger
    .filter((t) => t.status === 'open')
    .reduce((s, t) => s + t.pnlUsd, 0);
  const equityUsd = baselineCash() + realized + openUnrealized;
  const equity = buildEquitySeries(ledger, equityUsd, now, 30);
  const kpis = computeKpis(ledger, marks, equity);
  const first = equity[0]?.equity ?? equityUsd;
  const equity30dPct = first > 0 ? (equityUsd / first - 1) * 100 : 0;

  return { sessionId, ledger, kpis, equity, equityUsd, equity30dPct, generatedAt: now };
}
