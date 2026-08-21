/**
 * Scout exit enforcement — PURE. The Tier-2 integrity upgrade (08-20 capability
 * review): every lane's pre-registered exit was "compliance-on-the-model" — a
 * deterministic SIGNAL the model was merely *asked* to obey, and this desk's history
 * (leader-follow's 30-minute discretionary exits, trend-follow's churn) proves prose
 * doesn't hold. This module decides, deterministically, whether an open paper
 * position has hit its FROZEN lane exit; the daemon-side service executes the close.
 * The model keeps judgment only where the frozen rules give it none.
 *
 * SCOPE (deliberate): enforcement covers ONLY the exits the pre-registrations froze —
 *   - the hard stop (all lanes),
 *   - htf-trend: the 10d-channel daily close-through,
 *   - compression-straddle: the 4h close back through the BB mid,
 *   - leader-follow: the leader exiting/flipping, or the 72h time-stop.
 * It does NOT force-close ahead of calendar events: the open forward tests were
 * frozen WITHOUT an event-flatten rule, and bolting one on mid-test would change the
 * strategy being measured (the p-hack we forbid). Event handling stays the model's
 * advisory preference for CURRENT lanes; future pre-registrations may freeze an
 * event rule from day one.
 *
 * Null-safety doctrine: missing data NEVER exits (a blind close is an act, not a
 * safety) — except the stop check, which uses only the mark + the stored stop.
 */

import { htfTrendExitHit, type HtfTrendRead } from './htf-trend-signal-business-logic';
import { compressionExitHit, type CompressionRead } from './compression-squeeze-signal-business-logic';

export interface EnforceablePosition {
  sessionId: string;
  coin: string; // uppercase
  side: 'long' | 'short';
  lane: string | null; // lowercase lane tag, null on legacy rows
  entryPx: number;
  /** The advisory stop (positions.stop_px). Null = no stop stored (legacy row). */
  stopPx: number | null;
  /** Epoch ms the position row was opened; null if unknown. */
  openedAtMs: number | null;
}

export interface LeaderFollowContext {
  /** TRUE = the followed leader still holds the same-direction position; FALSE = the
   *  feed shows they exited/flipped; NULL = unknown (feed gap) → never exits. */
  leaderStillHolding: boolean | null;
}

export interface ExitDecision {
  reason: 'stop-hit' | 'htf-channel-exit' | 'compression-mid-exit' | 'leader-gone' | 'leader-time-stop';
  detail: string;
}

export const LEADER_FOLLOW_TIME_STOP_HOURS = 72;

/** The hard stop — mark at/through the stored stop. All lanes; the one check that
 *  needs nothing but the mark. No stop stored → no stop enforcement (legacy rows). */
export function stopHit(pos: EnforceablePosition, markPx: number): ExitDecision | null {
  if (pos.stopPx == null || !(pos.stopPx > 0) || !(markPx > 0)) return null;
  const hit = pos.side === 'long' ? markPx <= pos.stopPx : markPx >= pos.stopPx;
  return hit
    ? { reason: 'stop-hit', detail: `mark ${markPx} through the ${pos.side} stop ${pos.stopPx} (entry ${pos.entryPx})` }
    : null;
}

/** The lane's frozen mechanical exit. Reads are nullable — a missing scan NEVER exits. */
export function laneMechanicalExit(
  pos: EnforceablePosition,
  reads: {
    htf?: HtfTrendRead | null;
    compression?: CompressionRead | null;
    leaderFollow?: LeaderFollowContext | null;
  },
  now: number,
): ExitDecision | null {
  switch (pos.lane) {
    case 'htf-trend': {
      const r = reads.htf;
      if (!r) return null;
      return htfTrendExitHit(r, pos.side)
        ? {
            reason: 'htf-channel-exit',
            detail:
              pos.side === 'long'
                ? `daily close ${r.latestClose} below the 10d low ${r.don10Low} (frozen turtle exit)`
                : `daily close ${r.latestClose} above the 10d high ${r.don10High} (frozen turtle exit)`,
          }
        : null;
    }
    case 'compression-straddle': {
      const r = reads.compression;
      if (!r) return null;
      return compressionExitHit(r, pos.side)
        ? {
            reason: 'compression-mid-exit',
            detail: `4h close ${r.latestClose} back through the BB mid ${r.bbMid} — the expansion is over (frozen exit)`,
          }
        : null;
    }
    case 'leader-follow': {
      const ctx = reads.leaderFollow;
      if (ctx && ctx.leaderStillHolding === false) {
        return { reason: 'leader-gone', detail: 'the followed leader exited/flipped (frozen exit)' };
      }
      if (pos.openedAtMs != null && now - pos.openedAtMs >= LEADER_FOLLOW_TIME_STOP_HOURS * 3_600_000) {
        const h = ((now - pos.openedAtMs) / 3_600_000).toFixed(0);
        return { reason: 'leader-time-stop', detail: `held ${h}h ≥ the frozen ${LEADER_FOLLOW_TIME_STOP_HOURS}h time-stop` };
      }
      return null;
    }
    default:
      // Rubric lanes exit on GO-drop (needs the rubric read — model-side for now),
      // passive lanes have no active exit, legacy/null lanes get stop-only coverage.
      return null;
  }
}

/** Full decision for one position: the stop first (cheapest, most urgent), then the
 *  lane's mechanical exit. Null = hold (or insufficient data — which must HOLD). */
export function decideEnforcedExit(
  pos: EnforceablePosition,
  markPx: number | null,
  reads: Parameters<typeof laneMechanicalExit>[1],
  now: number,
): ExitDecision | null {
  if (markPx != null) {
    const stop = stopHit(pos, markPx);
    if (stop) return stop;
  }
  return laneMechanicalExit(pos, reads, now);
}
