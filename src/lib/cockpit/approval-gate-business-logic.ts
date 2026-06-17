/**
 * PURE decision logic for the approval gate (the NO-AUTO-FIRE core).
 *
 * The gate writes a `pending_actions` row and POLLS it until the human decides.
 * The "what does this status mean / should I keep polling / have I timed out"
 * decisions live here so they are exhaustively unit-tested with zero I/O. The
 * thin I/O (write row + poll Supabase + sleep) lives in approval-gate-service.ts.
 *
 * THE HARD INVARIANT: the gate resolves TRUE only on an explicit 'approved'.
 * Everything else — 'rejected', 'expired', timeout, a transient read error, or a
 * still-'pending' deadline — resolves FALSE. Default is NO.
 */

import type { PendingActionStatus } from '@/types/cockpit';

export type PollOutcome =
  | { kind: 'approved' }
  | { kind: 'rejected' }
  | { kind: 'expired' }
  | { kind: 'keep-polling' };

/**
 * Interpret a freshly-read status into a poll outcome. 'approved'/'rejected'/
 * 'expired' are terminal; 'pending' (or anything unexpected) means keep polling.
 */
export function interpretStatus(status: PendingActionStatus | string | null | undefined): PollOutcome {
  switch (status) {
    case 'approved':
      return { kind: 'approved' };
    case 'rejected':
      return { kind: 'rejected' };
    case 'expired':
      return { kind: 'expired' };
    default:
      // 'pending', null, unknown — not yet decided.
      return { kind: 'keep-polling' };
  }
}

/**
 * True once the polling deadline has passed. `startedAt + timeoutMs` is the
 * deadline; at/after it the gate must stop polling and resolve NO (expiring the
 * row). Uses >= so a zero timeout expires immediately.
 */
export function isPastDeadline(startedAt: number, now: number, timeoutMs: number): boolean {
  return now - startedAt >= timeoutMs;
}

/**
 * Map a terminal poll outcome to the gate's boolean result. ONLY 'approved'
 * yields true. This is the single chokepoint that enforces NO-AUTO-FIRE.
 */
export function outcomeToApproved(outcome: PollOutcome): boolean {
  return outcome.kind === 'approved';
}

/**
 * Validate a status transition for the approve/reject routes. A decision is only
 * legal from 'pending'; deciding an already-decided row is rejected (so a double
 * click or a race cannot flip an expired/rejected action into approved).
 */
export function canTransition(
  current: PendingActionStatus | string,
  next: 'approved' | 'rejected',
): boolean {
  return current === 'pending' && (next === 'approved' || next === 'rejected');
}

/** Default poll interval + timeout for the approval gate. */
export const DEFAULT_POLL_INTERVAL_MS = 1500;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
