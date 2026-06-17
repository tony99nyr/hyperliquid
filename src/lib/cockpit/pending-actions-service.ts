/**
 * Pending-actions service (I/O) — the approval-gate persistence + polling.
 *
 * Thin layer over the service-role client. The DECISION logic (what a status
 * means, deadline math, legal transitions) is the PURE
 * approval-gate-business-logic; this module only does Supabase reads/writes +
 * sleeping. Together they implement the NO-AUTO-FIRE gate: a row is written
 * 'pending', polled until decided, and resolves TRUE only on 'approved'.
 */

import { getServiceRoleClient } from './supabase-server';
import {
  interpretStatus,
  isPastDeadline,
  outcomeToApproved,
  canTransition,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from './approval-gate-business-logic';
import type {
  PendingAction,
  PendingActionKind,
  PendingActionProposal,
  PendingActionStatus,
} from '@/types/cockpit';
import type { TradingMode } from '@/types/fill';
import type { SupabaseClient } from '@supabase/supabase-js';

interface PendingActionRow {
  id: string;
  session_id: string;
  kind: PendingActionKind;
  mode: TradingMode;
  proposal: PendingActionProposal;
  status: PendingActionStatus;
  created_at: string;
  decided_at: string | null;
}

function toPendingAction(row: PendingActionRow): PendingAction {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    mode: row.mode,
    proposal: row.proposal,
    status: row.status,
    createdAt: new Date(row.created_at).getTime(),
    decidedAt: row.decided_at ? new Date(row.decided_at).getTime() : null,
  };
}

/** Insert a 'pending' approval request and return its created row. */
export async function createPendingAction(
  input: {
    sessionId: string;
    kind: PendingActionKind;
    mode: TradingMode;
    proposal: PendingActionProposal;
  },
  client: SupabaseClient = getServiceRoleClient(),
): Promise<PendingAction> {
  const { data, error } = await client
    .from('pending_actions')
    .insert({
      session_id: input.sessionId,
      kind: input.kind,
      mode: input.mode,
      proposal: input.proposal,
      status: 'pending',
    })
    .select()
    .single();
  if (error) throw new Error(`createPendingAction failed: ${error.message}`);
  return toPendingAction(data as PendingActionRow);
}

/** Read the current status of a pending action (null when not found). */
export async function readPendingActionStatus(
  id: string,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<PendingActionStatus | null> {
  const { data, error } = await client
    .from('pending_actions')
    .select('status')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`readPendingActionStatus failed: ${error.message}`);
  if (!data) return null;
  return (data as { status: PendingActionStatus }).status;
}

/**
 * Apply a decision to a pending action, enforcing the pending→decided transition
 * (the `.eq('status','pending')` makes it atomic — a double click or a race
 * cannot overwrite an already-decided row). Returns true when this call was the
 * one that decided it.
 */
export async function decidePendingAction(
  id: string,
  next: 'approved' | 'rejected',
  client: SupabaseClient = getServiceRoleClient(),
): Promise<boolean> {
  if (!canTransition('pending', next)) return false; // defensive; always true here
  const { data, error } = await client
    .from('pending_actions')
    .update({ status: next, decided_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id');
  if (error) throw new Error(`decidePendingAction failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Approve a pending action AND persist the operator-chosen leverage into the
 * proposal jsonb, atomically, in one update guarded on `status='pending'`.
 *
 * The leverage is the OPERATOR's risk decision (Item 3): the popup sends the
 * chosen value, the route SERVER-VALIDATES it to the coin's [1, max] band (never
 * trusting the client), and this writes it onto `proposal.intent.leverage` (the
 * value executeIntent runs with) and `proposal.display.leverage` (what the row
 * reflects). Flipping status + rewriting the proposal in a SINGLE update keeps it
 * race-safe: a double-click or a concurrent reject cannot land a second write
 * (the `.eq('status','pending')` makes exactly one call win). Notional is
 * untouched — leverage governs margin/liq/ROE only.
 *
 * Returns true when THIS call decided the row (matching decidePendingAction's
 * contract). The caller passes an ALREADY-VALIDATED leverage.
 */
export async function approveWithLeverage(
  id: string,
  validatedLeverage: number,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<boolean> {
  // Read the current proposal so we merge (rather than clobber) it. Reduce-only
  // exits keep intent.leverage undefined (the fold leaves stored leverage alone);
  // we only stamp the chosen leverage when the intent is an OPENING order.
  const current = await getPendingAction(id, client);
  if (!current || current.status !== 'pending') return false;

  const isOpening = current.proposal.intent.reduceOnly !== true;
  const nextProposal: PendingActionProposal = {
    intent: {
      ...current.proposal.intent,
      ...(isOpening ? { leverage: validatedLeverage } : {}),
    },
    display: {
      ...current.proposal.display,
      ...(isOpening ? { leverage: validatedLeverage } : {}),
    },
  };

  const { data, error } = await client
    .from('pending_actions')
    .update({ status: 'approved', decided_at: new Date().toISOString(), proposal: nextProposal })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id');
  if (error) throw new Error(`approveWithLeverage failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/** Mark a pending action 'expired' (timeout path). Idempotent-safe. */
export async function expirePendingAction(
  id: string,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<void> {
  const { error } = await client
    .from('pending_actions')
    .update({ status: 'expired', decided_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending');
  if (error) throw new Error(`expirePendingAction failed: ${error.message}`);
}

export interface PollOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Injectable clock + sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll a pending action until it is decided or the deadline passes. Resolves
 * TRUE only on 'approved'; 'rejected' ⇒ false; on timeout the row is marked
 * 'expired' and false is returned. THE NO-AUTO-FIRE default: any non-approve
 * outcome is false.
 */
export async function pollPendingAction(
  id: string,
  opts: PollOptions = {},
  client: SupabaseClient = getServiceRoleClient(),
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const startedAt = now();

  for (;;) {
    const status = await readPendingActionStatus(id, client);
    const outcome = interpretStatus(status);
    if (outcome.kind !== 'keep-polling') {
      return outcomeToApproved(outcome);
    }
    if (isPastDeadline(startedAt, now(), timeoutMs)) {
      // Deadline hit. The CONDITIONAL expire only flips a row that is STILL
      // 'pending' (its `.eq('status','pending')` guard). If the user approved at
      // the same instant, the expire is a no-op and the row stays 'approved'.
      // RE-READ to find out which actually happened and converge DB ⇄ outcome:
      //  - 'approved' → user beat the timer → resolve TRUE (execute).
      //  - 'expired'/'rejected'/etc. → resolve via the normal interpretation.
      await expirePendingAction(id, client);
      const finalStatus = await readPendingActionStatus(id, client);
      const finalOutcome = interpretStatus(finalStatus);
      if (finalOutcome.kind !== 'keep-polling') {
        return outcomeToApproved(finalOutcome);
      }
      return false; // still undecided after expire (shouldn't happen) — NO.
    }
    await sleep(pollIntervalMs);
  }
}

/** Read a full pending action by id (for the routes / UI). */
export async function getPendingAction(
  id: string,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<PendingAction | null> {
  const { data, error } = await client
    .from('pending_actions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getPendingAction failed: ${error.message}`);
  if (!data) return null;
  return toPendingAction(data as PendingActionRow);
}
