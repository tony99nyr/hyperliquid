/**
 * PURE row mappers for the realtime hooks.
 *
 * Supabase realtime delivers raw DB rows (snake_case, timestamps as ISO
 * strings). The hooks are thin transport (subscribe / accumulate / unsubscribe);
 * the snake_case → domain-type conversion lives here so it is fixture-testable
 * with zero I/O. Mirrors the row shapes in supabase/migrations/0001_init.sql.
 */

import type {
  AnalysisLogEntry,
  ContextGauge,
  ContextZone,
  HealthSnapshot,
  Hypothesis,
  HypothesisStatus,
  AlertSeverity,
} from '@/types/cockpit';

function toMs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

function toMsOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  return toMs(v);
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** A raw realtime row is an untyped record. */
export type RealtimeRow = Record<string, unknown>;

export function mapAnalysisLogRow(row: RealtimeRow): AnalysisLogEntry {
  return {
    id: str(row.id),
    sessionId: str(row.session_id),
    createdAt: toMs(row.created_at),
    source: str(row.source),
    severity: (str(row.severity) || 'info') as AlertSeverity,
    message: str(row.message),
  };
}

export function mapHealthSnapshotRow(row: RealtimeRow): HealthSnapshot {
  const rawAlerts = row.alerts;
  const alerts = Array.isArray(rawAlerts) ? rawAlerts.map((a) => str(a)) : [];
  return {
    id: str(row.id),
    sessionId: str(row.session_id),
    createdAt: toMs(row.created_at),
    score: num(row.score),
    pContinuation: num(row.p_continuation),
    pAdverse: num(row.p_adverse),
    alerts,
  };
}

export function mapContextGaugeRow(row: RealtimeRow): ContextGauge {
  return {
    id: str(row.id),
    sessionId: str(row.session_id),
    createdAt: toMs(row.created_at),
    approxPct: num(row.approx_pct),
    zone: (str(row.zone) || 'ok') as ContextZone,
  };
}

export function mapHypothesisRow(row: RealtimeRow): Hypothesis {
  return {
    id: str(row.id),
    sessionId: str(row.session_id),
    createdAt: toMs(row.created_at),
    statement: str(row.statement),
    status: (str(row.status) || 'open') as HypothesisStatus,
    resolvedAt: toMsOrNull(row.resolved_at),
    resolutionNote: row.resolution_note == null ? null : str(row.resolution_note),
  };
}

/** A pnl snapshot row (the `pnl` table). */
export interface PnlSnapshot {
  id: string;
  sessionId: string;
  coin: string;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  feesPaidUsd: number;
  markPx: number | null;
  createdAt: number;
}

export function mapPnlRow(row: RealtimeRow): PnlSnapshot {
  return {
    id: str(row.id),
    sessionId: str(row.session_id),
    coin: str(row.coin),
    realizedPnlUsd: num(row.realized_pnl_usd),
    unrealizedPnlUsd: num(row.unrealized_pnl_usd),
    feesPaidUsd: num(row.fees_paid_usd),
    markPx: row.mark_px == null ? null : num(row.mark_px),
    createdAt: toMs(row.created_at),
  };
}

/** A position row (the `positions` table). */
export interface PositionRow {
  id: string;
  sessionId: string;
  coin: string;
  side: 'long' | 'short' | 'flat';
  sz: number;
  avgEntryPx: number;
  realizedPnlUsd: number;
  feesPaidUsd: number;
  updatedAt: number;
}

export function mapPositionRow(row: RealtimeRow): PositionRow {
  const side = str(row.side);
  return {
    id: str(row.id),
    sessionId: str(row.session_id),
    coin: str(row.coin),
    side: side === 'long' || side === 'short' ? side : 'flat',
    sz: num(row.sz),
    avgEntryPx: num(row.avg_entry_px),
    realizedPnlUsd: num(row.realized_pnl_usd),
    feesPaidUsd: num(row.fees_paid_usd),
    updatedAt: toMs(row.updated_at),
  };
}

/**
 * Accumulate a new row into an existing list keyed by `id`, replacing any row
 * with the same id (handles INSERT + UPDATE) and keeping the list sorted by a
 * supplied comparator. PURE — returns a new array.
 */
export function accumulateById<T extends { id: string }>(
  prev: T[],
  next: T,
  compare: (a: T, b: T) => number,
): T[] {
  const without = prev.filter((r) => r.id !== next.id);
  without.push(next);
  return without.sort(compare);
}

/** Newest-first comparator on a `createdAt` field. */
export function byCreatedAtDesc<T extends { createdAt: number }>(a: T, b: T): number {
  return b.createdAt - a.createdAt;
}

/** Oldest-first comparator on a `createdAt` field. */
export function byCreatedAtAsc<T extends { createdAt: number }>(a: T, b: T): number {
  return a.createdAt - b.createdAt;
}
