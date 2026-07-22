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
  /** Strategy lane (scout multi-lane) — so per-lane win/loss can be attributed.
   * Omitted when undefined (a hypothesis has no coin to map a lane from). */
  lane?: string;
  /** The coin — lets a close resolve the open hypothesis for (session, coin)
   *  deterministically even if the id wasn't threaded through. */
  coin?: string;
}

export function buildHypothesisRow(input: {
  sessionId: string;
  statement: string;
  status?: HypothesisStatus;
  lane?: string;
  coin?: string;
}): HypothesisInsertRow {
  const row: HypothesisInsertRow = {
    session_id: input.sessionId,
    statement: input.statement,
    status: input.status ?? 'open',
  };
  if (typeof input.lane === 'string' && input.lane.trim() !== '') {
    row.lane = input.lane.trim();
  }
  if (typeof input.coin === 'string' && input.coin.trim() !== '') {
    row.coin = input.coin.trim().toUpperCase();
  }
  return row;
}

export interface HealthSnapshotInsertRow {
  session_id: string;
  /** The coin this assessment is for (per-position health). Omitted/null = legacy. */
  coin: string | null;
  score: number;
  p_continuation: number;
  p_adverse: number;
  alerts: string[];
}

export function buildHealthSnapshotRow(input: {
  sessionId: string;
  coin?: string | null;
  score: number;
  pContinuation: number;
  pAdverse: number;
  alerts: string[];
}): HealthSnapshotInsertRow {
  return {
    session_id: input.sessionId,
    // Normalize coin casing to match fills/positions (the watch daemon passes
    // position.coin verbatim); read-side also upper-cases, so this is hygiene.
    coin: input.coin ? input.coin.trim().toUpperCase() : null,
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
  /** ISO timestamp of the ACTUAL fill. Without this the column defaults to the
   *  INSERT time — indistinguishable for real-time executions, wrong for
   *  backfilled exchange-side fills (and it silently re-orders the fold). */
  filled_at: string;
}

export function buildFillRow(fill: CanonicalFill): FillInsertRow {
  return {
    session_id: fill.sessionId,
    client_intent_id: fill.clientIntentId,
    // Normalize so the ledger key matches the positions (session, coin) key.
    coin: fill.coin.trim().toUpperCase(),
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
    filled_at: new Date(fill.filledAt).toISOString(),
  };
}

/** A `fills` row as read back from the DB (snake_case, for folding the ledger). */
export interface FillSelectRow {
  client_intent_id: string;
  session_id: string;
  coin: string;
  side: CanonicalFill['side'];
  px: number | string;
  sz: number | string;
  notional_usd: number | string;
  fee_usd: number | string;
  reduce_only: boolean;
  partial: boolean;
  source: TradingMode;
  hl_order_id: string | null;
  hl_raw: Record<string, unknown> | null;
  filled_at: string | number;
}

/** Coerce a Postgres numeric (which PostgREST may surface as a string) to a number. */
function toNum(v: number | string | null | undefined): number {
  if (typeof v === 'number') return v;
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reconstruct a domain CanonicalFill from a DB `fills` row. The inverse of
 * `buildFillRow`; used by the fill-persistence service to fold the whole ledger
 * back into a position (the idempotent, crash-consistent recompute). PURE.
 */
export function fillFromRow(row: FillSelectRow): CanonicalFill {
  return {
    clientIntentId: row.client_intent_id,
    sessionId: row.session_id,
    coin: row.coin,
    side: row.side,
    px: toNum(row.px),
    sz: toNum(row.sz),
    notionalUsd: toNum(row.notional_usd),
    feeUsd: toNum(row.fee_usd),
    reduceOnly: row.reduce_only,
    partial: row.partial,
    source: row.source,
    hlOrderId: row.hl_order_id,
    hlRaw: row.hl_raw,
    filledAt: typeof row.filled_at === 'number' ? row.filled_at : new Date(row.filled_at).getTime(),
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
  /**
   * Position leverage (e.g. 5 = 5x). METADATA set from the opening intent — the
   * fold (applyFills) stays leverage-AGNOSTIC (ADR-0001); leverage is carried
   * here purely so the UI can derive ROE. Omitted from the row when undefined so
   * an upsert that doesn't know the leverage (e.g. a reduce-only fold) does NOT
   * clobber a previously-stored value to NULL — see buildPositionRow.
   */
  leverage?: number | null;
  /** When the current open run started (ISO), or null when flat. Drives "held". */
  opened_at?: string | null;
  /**
   * Strategy lane (scout multi-lane refactor). METADATA like `leverage` — omitted
   * when undefined so a lane-unaware re-fold (e.g. a reduce-only exit) preserves
   * the lane set at entry rather than nulling it. Null for non-lane-scoped books.
   */
  lane?: string | null;
}

/**
 * Build the positions upsert row. `leverage` is OPTIONAL metadata: when provided
 * (the opening fill carried the intent's leverage) it is written; when undefined
 * the column is left OUT of the payload entirely so a subsequent leverage-unaware
 * upsert (a reduce-only re-fold) preserves the leverage set at entry rather than
 * nulling it. The position size/pnl always recompute from fills (leverage-agnostic).
 * `openedAtIso` is fold-derived (computeOpenedAtMs) — always written (incl. null on
 * flat) since it recomputes deterministically from the full ledger.
 */
export function buildPositionRow(
  sessionId: string,
  pos: Position,
  updatedAtIso: string,
  leverage?: number | null,
  openedAtIso?: string | null,
  lane?: string | null,
): PositionUpsertRow {
  const row: PositionUpsertRow = {
    session_id: sessionId,
    coin: pos.coin,
    side: pos.side,
    sz: pos.sz,
    avg_entry_px: pos.avgEntryPx,
    realized_pnl_usd: pos.realizedPnlUsd,
    fees_paid_usd: pos.feesPaidUsd,
    updated_at: updatedAtIso,
  };
  // Only attach leverage when known — a positive, finite number. Undefined/null
  // leaves the column untouched on upsert (don't clobber the entry leverage).
  if (leverage !== undefined && leverage !== null && Number.isFinite(leverage) && leverage > 0) {
    row.leverage = leverage;
  }
  if (openedAtIso !== undefined) row.opened_at = openedAtIso;
  // Lane metadata: attach only a non-empty string; undefined/null/'' leaves the
  // column untouched on upsert so a reduce-only re-fold preserves the entry lane.
  if (typeof lane === 'string' && lane.trim() !== '') {
    row.lane = lane.trim();
  }
  return row;
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
