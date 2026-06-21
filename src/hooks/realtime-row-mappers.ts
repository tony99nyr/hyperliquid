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
  PendingAction,
  PendingActionKind,
  PendingActionProposal,
  PendingActionReview,
  PendingActionStatus,
  SafeExitPlan,
} from '@/types/cockpit';
import type { TradeIntent, TradingMode } from '@/types/fill';

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
    coin: row.coin == null ? null : str(row.coin),
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
  /** Position leverage (e.g. 5 = 5x), or null when unknown. Drives ROE. */
  leverage: number | null;
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
    leverage: row.leverage == null ? null : num(row.leverage),
    updatedAt: toMs(row.updated_at),
  };
}

/**
 * Map a `pending_actions` row (the approval-gate queue). `proposal` is a jsonb
 * column delivered as an already-parsed object by realtime; we trust its shape
 * (written by the service-role gate) and coerce the scalar columns defensively.
 */
export function mapPendingActionRow(row: RealtimeRow): PendingAction {
  return {
    id: str(row.id),
    sessionId: str(row.session_id),
    kind: (str(row.kind) || 'generic') as PendingActionKind,
    mode: (str(row.mode) || 'paper') as TradingMode,
    proposal: (row.proposal ?? { intent: {} as TradeIntent, display: {} }) as PendingActionProposal,
    status: (str(row.status) || 'pending') as PendingActionStatus,
    // Legacy/cached rows may lack origin — default to 'skill'. review stays null
    // until Claude annotates a preview.
    origin: row.origin === 'operator' ? 'operator' : 'skill',
    review: (row.review ?? null) as PendingActionReview | null,
    createdAt: toMs(row.created_at),
    decidedAt: toMsOrNull(row.decided_at),
  };
}

/** Map a `safe_exit_plan` row (the dead-man's-switch backstop). */
export function mapSafeExitPlanRow(row: RealtimeRow): SafeExitPlan {
  return {
    id: str(row.id),
    sessionId: str(row.session_id),
    intent: (row.intent ?? ({} as TradeIntent)) as TradeIntent,
    reasoning: row.reasoning == null ? null : str(row.reasoning),
    isFallback: row.is_fallback === true,
    updatedAt: toMs(row.updated_at),
  };
}

/** Newest-first comparator on an `updatedAt` field. */
export function byUpdatedAtDesc<T extends { updatedAt: number }>(a: T, b: T): number {
  return b.updatedAt - a.updatedAt;
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

/**
 * A leader_positions row — the watcher's live, reconciled view of ONE leader's
 * open position in ONE coin (GLOBAL: no session_id). Powers the rail's
 * "has position" filter, Leader-vs-You, and the trader-detail drawer (replacing
 * the on-demand HL proxy). Mirrors the HlPosition shape so it drops into the
 * existing position panels.
 */
export interface LeaderPositionRow {
  /** Synthetic id (leader_address:coin) — leader_positions has no `id` column. */
  id: string;
  leaderAddress: string;
  coin: string;
  side: 'long' | 'short';
  /** Signed size in coin units (negative = short). */
  szi: number;
  /** Absolute size in coin units. */
  size: number;
  entryPx: number | null;
  positionValue: number;
  unrealizedPnl: number;
  returnOnEquity: number | null;
  leverage: number | null;
  leverageType: string | null;
  liquidationPx: number | null;
  accountValueUsd: number | null;
  fetchedAt: number;
  updatedAt: number;
}

export function mapLeaderPositionRow(row: RealtimeRow): LeaderPositionRow {
  const leaderAddress = str(row.leader_address);
  const coin = str(row.coin);
  const rawSide = str(row.side);
  const side = rawSide === 'short' ? 'short' : 'long';
  return {
    id: `${leaderAddress.toLowerCase()}:${coin.toUpperCase()}`,
    leaderAddress,
    coin,
    side,
    szi: num(row.szi),
    size: num(row.size),
    entryPx: row.entry_px == null ? null : num(row.entry_px),
    positionValue: num(row.position_value),
    unrealizedPnl: num(row.unrealized_pnl),
    returnOnEquity: row.return_on_equity == null ? null : num(row.return_on_equity),
    leverage: row.leverage == null ? null : num(row.leverage),
    leverageType: row.leverage_type == null ? null : str(row.leverage_type),
    liquidationPx: row.liquidation_px == null ? null : num(row.liquidation_px),
    accountValueUsd: row.account_value_usd == null ? null : num(row.account_value_usd),
    fetchedAt: toMs(row.fetched_at),
    updatedAt: toMs(row.updated_at),
  };
}

/** The kinds of leader action the watcher records (append-only event log). */
export type LeaderActionKind = 'open' | 'add' | 'reduce' | 'close' | 'flip';
const LEADER_ACTION_KINDS = new Set<string>(['open', 'add', 'reduce', 'close', 'flip']);

/**
 * A leader_actions row — one append-only event in a leader's book (GLOBAL: no
 * session_id). Powers the live action feed. `id` is synthesized from the natural
 * key when the table exposes no `id` column.
 */
export interface LeaderActionRow {
  id: string;
  leaderAddress: string;
  coin: string;
  kind: LeaderActionKind;
  prevSide: 'long' | 'short' | null;
  newSide: 'long' | 'short' | null;
  prevSize: number | null;
  newSize: number | null;
  sizeDelta: number;
  entryPx: number | null;
  notionalUsd: number | null;
  unrealizedPnl: number | null;
  detectedAt: number;
}

function sideOrNull(v: unknown): 'long' | 'short' | null {
  const s = str(v);
  return s === 'long' || s === 'short' ? s : null;
}

export function mapLeaderActionRow(row: RealtimeRow): LeaderActionRow {
  const leaderAddress = str(row.leader_address);
  const coin = str(row.coin);
  const rawKind = str(row.kind);
  const kind = (LEADER_ACTION_KINDS.has(rawKind) ? rawKind : 'add') as LeaderActionKind;
  const detectedAt = toMs(row.detected_at);
  // leader_actions is append-only and may lack an `id` column; synthesize a
  // stable-enough key (a leader can't log two events for one coin at the same ms).
  const id = row.id != null ? str(row.id) : `${leaderAddress.toLowerCase()}:${coin.toUpperCase()}:${kind}:${detectedAt}`;
  return {
    id,
    leaderAddress,
    coin,
    kind,
    prevSide: sideOrNull(row.prev_side),
    newSide: sideOrNull(row.new_side),
    prevSize: row.prev_size == null ? null : num(row.prev_size),
    newSize: row.new_size == null ? null : num(row.new_size),
    sizeDelta: num(row.size_delta),
    entryPx: row.entry_px == null ? null : num(row.entry_px),
    notionalUsd: row.notional_usd == null ? null : num(row.notional_usd),
    unrealizedPnl: row.unrealized_pnl == null ? null : num(row.unrealized_pnl),
    detectedAt,
  };
}

/** Newest-first comparator on a `detectedAt` field. */
export function byDetectedAtDesc<T extends { detectedAt: number }>(a: T, b: T): number {
  return b.detectedAt - a.detectedAt;
}

/** Newest-first comparator on a `createdAt` field. */
export function byCreatedAtDesc<T extends { createdAt: number }>(a: T, b: T): number {
  return b.createdAt - a.createdAt;
}

/** Oldest-first comparator on a `createdAt` field. */
export function byCreatedAtAsc<T extends { createdAt: number }>(a: T, b: T): number {
  return a.createdAt - b.createdAt;
}

/**
 * A rubric_scores row (one per coin×side) — the deterministic opportunity read.
 * id = `${coin}:${side}` so realtime updates REPLACE (newest per coin/side wins),
 * like leader_positions. Mirrors supabase/migrations/0009_rubric.sql.
 */
export interface RubricScoreUiRow {
  id: string;
  coin: string;
  side: 'long' | 'short';
  opportunity: number;
  pillarRegime: number;
  pillarLeaders: number;
  pillarCarry: number;
  pillarMicro: number;
  regimeMultiplier: number;
  badge: 'GO' | 'WATCH' | 'NO-EDGE';
  chosenSide: 'long' | 'short' | 'none';
  noTradeReason: string | null;
  entryLow: number | null;
  entryHigh: number | null;
  invalidation: number | null;
  target: number | null;
  triggerPx: number | null;
  roomToTarget: number | null;
  confidence: number;
  scoreBandLow: number;
  scoreBandHigh: number;
  killedBy: string | null;
  computedAt: number;
}

export function mapRubricScoreRow(row: RealtimeRow): RubricScoreUiRow {
  const coin = str(row.coin).toUpperCase();
  const side = str(row.side) === 'short' ? 'short' : 'long';
  const badgeRaw = str(row.badge);
  const badge = badgeRaw === 'GO' || badgeRaw === 'WATCH' ? badgeRaw : 'NO-EDGE';
  const chosenRaw = str(row.chosen_side);
  const chosenSide = chosenRaw === 'long' || chosenRaw === 'short' ? chosenRaw : 'none';
  return {
    id: `${coin}:${side}`,
    coin,
    side,
    opportunity: num(row.opportunity),
    pillarRegime: num(row.pillar_regime),
    pillarLeaders: num(row.pillar_leaders),
    pillarCarry: num(row.pillar_carry),
    pillarMicro: num(row.pillar_micro),
    regimeMultiplier: num(row.regime_multiplier),
    badge,
    chosenSide,
    noTradeReason: row.no_trade_reason == null ? null : str(row.no_trade_reason),
    entryLow: row.entry_low == null ? null : num(row.entry_low),
    entryHigh: row.entry_high == null ? null : num(row.entry_high),
    invalidation: row.invalidation == null ? null : num(row.invalidation),
    target: row.target == null ? null : num(row.target),
    triggerPx: row.trigger_px == null ? null : num(row.trigger_px),
    roomToTarget: row.room_to_target == null ? null : num(row.room_to_target),
    confidence: num(row.confidence),
    scoreBandLow: num(row.score_band_low),
    scoreBandHigh: num(row.score_band_high),
    killedBy: row.killed_by == null ? null : str(row.killed_by),
    computedAt: toMs(row.computed_at),
  };
}

/** Stable comparator: coin asc, then side (long before short). */
export function byCoinSideAsc(a: RubricScoreUiRow, b: RubricScoreUiRow): number {
  return a.coin === b.coin ? a.side.localeCompare(b.side) : a.coin.localeCompare(b.coin);
}
