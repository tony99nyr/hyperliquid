/**
 * PURE row builders + classifiers for the cockpit services.
 *
 * The cockpit services are a thin I/O layer over Supabase; the row-shape
 * construction (camelCase domain object → snake_case DB row) and any
 * classification logic live here so they are unit-testable with zero I/O.
 *
 * DB column names mirror supabase/migrations/0001_init.sql. `id`/`created_at`
 * are omitted from insert rows — the database fills them via defaults.
 */

import type { CanonicalFill } from '@/types/fill';
import type { Position } from '@/types/position';
import type {
  AlertSeverity,
  ContextZone,
  HypothesisStatus,
  SessionStatus,
} from '@/types/cockpit';
import type { TradingMode } from '@/types/fill';

// ---------------------------------------------------------------------------
// Context gauge zone classification (PURE).
// ---------------------------------------------------------------------------

/**
 * Classify an approximate context-usage percent into a zone:
 *   ok       < 60 ≤ warn < 85 ≤ critical
 * Out-of-range inputs are clamped to [0, 100] before classifying.
 */
export function classifyContextZone(approxPct: number): ContextZone {
  const pct = Math.max(0, Math.min(100, approxPct));
  if (pct < 60) return 'ok';
  if (pct < 85) return 'warn';
  return 'critical';
}

// ---------------------------------------------------------------------------
// Insert-row builders (camelCase → snake_case DB rows).
// ---------------------------------------------------------------------------

export interface SessionInsertRow {
  status: SessionStatus;
  mode: TradingMode;
  title: string | null;
  leader_address: string | null;
}

export function buildSessionRow(input: {
  mode: TradingMode;
  title?: string | null;
  leaderAddress?: string | null;
  status?: SessionStatus;
}): SessionInsertRow {
  return {
    status: input.status ?? 'active',
    mode: input.mode,
    title: input.title ?? null,
    leader_address: input.leaderAddress ?? null,
  };
}

export interface AnalysisLogInsertRow {
  session_id: string;
  source: string;
  severity: AlertSeverity;
  message: string;
}

export function buildAnalysisLogRow(input: {
  sessionId: string;
  source: string;
  message: string;
  severity?: AlertSeverity;
}): AnalysisLogInsertRow {
  return {
    session_id: input.sessionId,
    source: input.source,
    severity: input.severity ?? 'info',
    message: input.message,
  };
}

export interface HypothesisInsertRow {
  session_id: string;
  statement: string;
  status: HypothesisStatus;
}

export function buildHypothesisRow(input: {
  sessionId: string;
  statement: string;
  status?: HypothesisStatus;
}): HypothesisInsertRow {
  return {
    session_id: input.sessionId,
    statement: input.statement,
    status: input.status ?? 'open',
  };
}

export interface HealthSnapshotInsertRow {
  session_id: string;
  score: number;
  p_continuation: number;
  p_adverse: number;
  alerts: string[];
}

export function buildHealthSnapshotRow(input: {
  sessionId: string;
  score: number;
  pContinuation: number;
  pAdverse: number;
  alerts: string[];
}): HealthSnapshotInsertRow {
  return {
    session_id: input.sessionId,
    score: input.score,
    p_continuation: input.pContinuation,
    p_adverse: input.pAdverse,
    alerts: input.alerts,
  };
}

export interface ContextGaugeInsertRow {
  session_id: string;
  approx_pct: number;
  zone: ContextZone;
}

export function buildContextGaugeRow(input: {
  sessionId: string;
  approxPct: number;
}): ContextGaugeInsertRow {
  return {
    session_id: input.sessionId,
    approx_pct: input.approxPct,
    zone: classifyContextZone(input.approxPct),
  };
}

// ---------------------------------------------------------------------------
// Fill + position + pnl rows (used by the fill→DB wiring).
// ---------------------------------------------------------------------------

export interface FillInsertRow {
  session_id: string;
  client_intent_id: string;
  coin: string;
  side: CanonicalFill['side'];
  px: number;
  sz: number;
  notional_usd: number;
  fee_usd: number;
  reduce_only: boolean;
  partial: boolean;
  source: TradingMode;
  hl_order_id: string | null;
  hl_raw: Record<string, unknown> | null;
}

export function buildFillRow(fill: CanonicalFill): FillInsertRow {
  return {
    session_id: fill.sessionId,
    client_intent_id: fill.clientIntentId,
    coin: fill.coin,
    side: fill.side,
    px: fill.px,
    sz: fill.sz,
    notional_usd: fill.notionalUsd,
    fee_usd: fill.feeUsd,
    reduce_only: fill.reduceOnly,
    partial: fill.partial,
    source: fill.source,
    hl_order_id: fill.hlOrderId,
    hl_raw: fill.hlRaw,
  };
}

export interface PositionUpsertRow {
  session_id: string;
  coin: string;
  side: Position['side'];
  sz: number;
  avg_entry_px: number;
  realized_pnl_usd: number;
  fees_paid_usd: number;
  updated_at: string;
}

export function buildPositionRow(
  sessionId: string,
  pos: Position,
  updatedAtIso: string,
): PositionUpsertRow {
  return {
    session_id: sessionId,
    coin: pos.coin,
    side: pos.side,
    sz: pos.sz,
    avg_entry_px: pos.avgEntryPx,
    realized_pnl_usd: pos.realizedPnlUsd,
    fees_paid_usd: pos.feesPaidUsd,
    updated_at: updatedAtIso,
  };
}

export interface PnlInsertRow {
  session_id: string;
  coin: string;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  fees_paid_usd: number;
  mark_px: number | null;
}

/**
 * Build a pnl snapshot row from a position. Unrealized P&L needs a mark price;
 * a fill records realized + fees, so unrealized is 0 and mark is null unless a
 * caller supplies one.
 */
export function buildPnlRow(
  sessionId: string,
  pos: Position,
  opts: { unrealizedPnlUsd?: number; markPx?: number | null } = {},
): PnlInsertRow {
  return {
    session_id: sessionId,
    coin: pos.coin,
    realized_pnl_usd: pos.realizedPnlUsd,
    unrealized_pnl_usd: opts.unrealizedPnlUsd ?? 0,
    fees_paid_usd: pos.feesPaidUsd,
    mark_px: opts.markPx ?? null,
  };
}

/**
 * Map a DB position row (snake_case) back to a domain Position. Used when the
 * fill-tracker loads the current position before folding a new fill.
 */
export function positionFromRow(row: {
  coin: string;
  side: Position['side'];
  sz: number;
  avg_entry_px: number;
  realized_pnl_usd: number;
  fees_paid_usd: number;
}): Position {
  return {
    coin: row.coin,
    side: row.side,
    sz: row.sz,
    avgEntryPx: row.avg_entry_px,
    realizedPnlUsd: row.realized_pnl_usd,
    feesPaidUsd: row.fees_paid_usd,
  };
}
