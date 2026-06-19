/**
 * Cockpit state types — the durable, low-frequency rows pushed to the browser
 * via Supabase realtime (the second transport; market data is the first and is
 * never stored). Mirrors the supabase/migrations/0001_init.sql tables. See
 * ADR-0002.
 */

import type { TradeIntent, TradingMode } from './fill';

export type SessionStatus = 'active' | 'closed';

export interface Session {
  id: string;
  createdAt: number;
  status: SessionStatus;
  mode: TradingMode;
  /** Free-text title the human/Claude set when opening the session. */
  title: string | null;
  /** Leader wallet being followed this session, if any. */
  leaderAddress: string | null;
}

export type AlertSeverity = 'info' | 'warn' | 'danger';

/** A line in Claude's live analysis stream. */
export interface AnalysisLogEntry {
  id: string;
  sessionId: string;
  createdAt: number;
  /** Which skill emitted it (analyze-traders, analyze-market-timeframes, …). */
  source: string;
  severity: AlertSeverity;
  message: string;
}

export type HypothesisStatus = 'open' | 'confirmed' | 'invalidated' | 'resolved';

/** A trade thesis the human + Claude are tracking for the session. */
export interface Hypothesis {
  id: string;
  sessionId: string;
  createdAt: number;
  statement: string;
  status: HypothesisStatus;
  resolvedAt: number | null;
  resolutionNote: string | null;
}

/** A health-engine snapshot written each assessment cycle (per session + COIN —
 *  each open position carries its own health; legacy rows may have a null coin). */
export interface HealthSnapshot {
  id: string;
  sessionId: string;
  /** The coin this assessment is for; null on legacy (pre-coin-scope) rows. */
  coin: string | null;
  createdAt: number;
  /** 0–100 composite health score. */
  score: number;
  pContinuation: number;
  pAdverse: number;
  /** Discrete alert codes, e.g. ['bearish-divergence-1h','stop-within-1-ATR']. */
  alerts: string[];
}

export type ContextZone = 'ok' | 'warn' | 'critical';

/** Rough self-reported Claude context-usage gauge (a safety cue, not a meter). */
export interface ContextGauge {
  id: string;
  sessionId: string;
  createdAt: number;
  /** Approximate context used, 0–100. */
  approxPct: number;
  zone: ContextZone;
}

// ---------------------------------------------------------------------------
// Phase 1: approval gate + Safe-Exit backstop (the trade-execution path).
// ---------------------------------------------------------------------------

export type PendingActionKind = 'entry' | 'exit' | 'generic';
export type PendingActionStatus =
  | 'pending' // skill-authored, awaiting decision (the polling skill executes)
  | 'preview' // operator-authored, awaiting decision (executes route-driven)
  | 'executing' // atomic claim held while the in-route executor runs (anti-double-fire)
  | 'approved' // skill path terminal: decided yes → the skill fires
  | 'rejected' // declined / discarded — never executes
  | 'executed' // operator path terminal: executed in-route (distinct from 'approved')
  | 'expired'; // timed out — never executes

/** Who authored a pending action — drives which execute path applies. */
export type PendingActionOrigin = 'skill' | 'operator';

/** Claude's evaluation of an operator PREVIEW (advisory; never executes). */
export interface PendingActionReview {
  verdict: 'endorse' | 'caution' | 'avoid';
  note: string;
  /** epoch ms when Claude wrote the review. */
  reviewedAt: number;
}

/**
 * Human-readable display fields for a proposed action, surfaced in the approval
 * popup. Carried inside the `proposal` jsonb alongside the executable intent so
 * the UI renders without re-deriving anything.
 */
export interface PendingActionDisplay {
  coin: string;
  side: OrderSideLabel;
  sz: number;
  /** Entry / estimated fill price, when known. */
  estPx?: number | null;
  /** Protective stop, when the proposal carries one. */
  stopPx?: number | null;
  rationale: string;
  /**
   * Proposal leverage (default for the popup slider). Mirrors
   * `proposal.intent.leverage`; carried in display so the popup renders the
   * default without re-deriving. The operator may change it (Item 3); the chosen
   * value is server-validated against `coinMaxLeverage` and persisted on approve.
   */
  leverage?: number | null;
  /**
   * The coin's max leverage — the slider ceiling AND the server-side validation
   * bound (1..coinMaxLeverage). Prefer the followed leader's reported max on this
   * coin; else a conservative per-coin default. The SERVER re-clamps to this
   * regardless of what the client sends.
   */
  coinMaxLeverage?: number | null;
  /** The followed leader's leverage on this coin (for the "Match leader" preset). */
  leaderLeverage?: number | null;
  /** The followed leader's address (short-rendered in the card). */
  leaderAddress?: string | null;
}

/** Buy/sell label re-export to avoid a fill.ts import in pure UI mappers. */
export type OrderSideLabel = 'buy' | 'sell';

/**
 * The `proposal` jsonb payload: the executable TradeIntent PLUS the display
 * fields. The intent is what executeIntent runs on approval; display is for the
 * popup only.
 */
export interface PendingActionProposal {
  intent: TradeIntent;
  display: PendingActionDisplay;
}

/** A queued approval request — the NO-AUTO-FIRE row (`pending_actions`). */
export interface PendingAction {
  id: string;
  sessionId: string;
  kind: PendingActionKind;
  mode: TradingMode;
  proposal: PendingActionProposal;
  status: PendingActionStatus;
  /** Who authored the row. Legacy/skill rows default to 'skill'. */
  origin: PendingActionOrigin;
  /** Claude's evaluation of an operator preview, or null when not yet reviewed. */
  review: PendingActionReview | null;
  createdAt: number;
  decidedAt: number | null;
}

/** The current reduce-only exit plan for a session (`safe_exit_plan`). */
export interface SafeExitPlan {
  id: string;
  sessionId: string;
  /** The reduce-only exit TradeIntent (opposite side, full size, market). */
  intent: TradeIntent;
  reasoning: string | null;
  /** True when this is the mechanical market-close fallback, not Claude-authored. */
  isFallback: boolean;
  updatedAt: number;
}
