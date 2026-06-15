/**
 * Cockpit state types — the durable, low-frequency rows pushed to the browser
 * via Supabase realtime (the second transport; market data is the first and is
 * never stored). Mirrors the supabase/migrations/0001_init.sql tables. See
 * ADR-0002.
 */

import type { TradingMode } from './fill';

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

/** A health-engine snapshot written each assessment cycle. */
export interface HealthSnapshot {
  id: string;
  sessionId: string;
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
