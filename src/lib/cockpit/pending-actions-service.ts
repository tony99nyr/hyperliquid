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
      await expirePendingAction(id, client);
      return false; // timed out — NO.
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
