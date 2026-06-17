/**
 * advise-exit — PURE exit recommendation + reduce-only intent builder
 * (fixture-tested).
 *
 * Recommends a full or partial exit of an open position with a health-engine
 * rationale, and builds the reduce-only TradeIntent that would close that
 * fraction. The script (scripts/advise-exit.ts) presents the recommendation and
 * REQUIRES EXPLICIT user confirmation before calling executeIntent. This module
 * NEVER executes — it only proposes the exit and the intent.
 *
 * No I/O, no clock except the injected `now`.
 */

import type { TradeIntent } from '@/types/fill';
import type { Position } from '@/types/position';
import type { HealthResult } from '@/lib/health/health-engine-types';

export type ExitKind = 'full' | 'partial' | 'none';

export interface ExitRecommendation {
  kind: ExitKind;
  /** Fraction of the open size to close (0..1). 0 when kind === 'none'. */
  exitFraction: number;
  /** Size in coin units to close (exitFraction * position.sz). */
  exitSz: number;
  reason: string;
}

export interface ExitProposal extends ExitRecommendation {
  /** The reduce-only intent that closes `exitSz` — null when kind === 'none'. */
  intent: TradeIntent | null;
  warnings: string[];
}

/** Score thresholds for the exit decision. */
export const EXIT_THRESHOLDS = {
  /** Below this score ⇒ full exit. */
  fullExitScore: 35,
  /** Below this score (but above full) ⇒ partial exit. */
  partialExitScore: 60,
  /** A regime flip against the position forces a full exit regardless of score. */
  fullExitAlerts: ['regime-flip-8h'] as const,
  /** Default partial-trim fraction. */
  partialFraction: 0.5,
} as const;

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Recommend an exit from the position + its health. PURE.
 *
 * - regime flip against the position OR score < fullExitScore ⇒ full exit.
 * - score < partialExitScore ⇒ partial exit (default half).
 * - otherwise ⇒ none (the position is healthy; do not advise an exit).
 */
export function recommendExit(position: Position, health: HealthResult): ExitRecommendation {
  const t = EXIT_THRESHOLDS;
  if (position.side === 'flat' || position.sz <= 0) {
    return { kind: 'none', exitFraction: 0, exitSz: 0, reason: 'No open position to exit.' };
  }

  const hardExit = health.alerts.find((a) => (t.fullExitAlerts as readonly string[]).includes(a));
  if (hardExit || health.score < t.fullExitScore) {
    const why = hardExit
      ? `Hard exit signal: ${hardExit}.`
      : `Health ${Math.round(health.score)} below full-exit floor ${t.fullExitScore}.`;
    return {
      kind: 'full',
      exitFraction: 1,
      exitSz: round(position.sz, 6),
      reason: `${why} Close the full position.`,
    };
  }

  if (health.score < t.partialExitScore) {
    const exitSz = round(position.sz * t.partialFraction, 6);
    return {
      kind: 'partial',
      exitFraction: t.partialFraction,
      exitSz,
      reason: `Health ${Math.round(health.score)} below hold bar ${t.partialExitScore}; trim ${Math.round(t.partialFraction * 100)}% and keep a runner.`,
    };
  }

  return {
    kind: 'none',
    exitFraction: 0,
    exitSz: 0,
    reason: `Health ${Math.round(health.score)} healthy; P(continuation) ${(health.pContinuation * 100).toFixed(0)}%. Hold — no exit advised.`,
  };
}

/**
 * A user-discretionary FULL exit that overrides the engine. PURE.
 *
 * The cockpit rule is "the user decides every action" — an engine HOLD must not
 * trap the user in a position they have decided to leave. This forces a full
 * close regardless of score/alerts. A flat position still yields `none` (there
 * is nothing to close).
 */
export function forcedFullExit(position: Position): ExitRecommendation {
  if (position.side === 'flat' || position.sz <= 0) {
    return { kind: 'none', exitFraction: 0, exitSz: 0, reason: 'No open position to exit.' };
  }
  return {
    kind: 'full',
    exitFraction: 1,
    exitSz: round(position.sz, 6),
    reason: 'User-discretionary full exit (--force) — overrides the engine recommendation.',
  };
}

/**
 * Build the full exit proposal: the recommendation PLUS the reduce-only
 * TradeIntent that closes `exitSz`. PURE.
 *
 * A long is reduced/closed by a SELL; a short by a BUY. The intent is always
 * `reduceOnly: true` (it can only shrink the position, never open/flip). Returns
 * `intent: null` when kind === 'none'.
 *
 * When `opts.force` is set the engine recommendation is overridden by a
 * discretionary full close (`forcedFullExit`) — the user has decided to exit
 * even though the engine may read HOLD.
 */
export function buildExitProposal(
  position: Position,
  health: HealthResult,
  opts: { clientIntentId: string; now: number; force?: boolean },
): ExitProposal {
  const rec = opts.force ? forcedFullExit(position) : recommendExit(position, health);
  const warnings: string[] = [];

  if (rec.kind === 'none') {
    return { ...rec, intent: null, warnings };
  }
  if (rec.exitSz <= 0) {
    warnings.push('Computed exit size is zero — nothing to close.');
    return { ...rec, intent: null, warnings };
  }

  // Closing side is opposite the position direction.
  const side = position.side === 'long' ? 'sell' : 'buy';
  const intent: TradeIntent = {
    clientIntentId: opts.clientIntentId,
    sessionId: '', // filled by the caller (script knows the active session)
    coin: position.coin,
    side,
    sz: rec.exitSz,
    reduceOnly: true,
    createdAt: opts.now,
  };

  return { ...rec, intent, warnings };
}
