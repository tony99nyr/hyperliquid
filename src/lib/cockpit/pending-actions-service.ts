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
  PendingActionOrigin,
  PendingActionProposal,
  PendingActionReview,
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
  origin: PendingActionOrigin | null;
  review: PendingActionReview | null;
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
    // Legacy rows (pre-0005) have no origin — default to 'skill' (the historical
    // author of every pending_action).
    origin: row.origin === 'operator' ? 'operator' : 'skill',
    review: row.review ?? null,
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
      origin: 'skill',
    })
    .select()
    .single();
  if (error) throw new Error(`createPendingAction failed: ${error.message}`);
  return toPendingAction(data as PendingActionRow);
}

// ---------------------------------------------------------------------------
// Operator PREVIEW lifecycle (the cockpit-native, route-driven path).
//
// A preview is authored by the OPERATOR (origin='operator', status='preview'),
// NOT by a polling skill — so its execution is route-driven (claim → execute →
// finalize), never picked up by `pollPendingAction` (which scopes by its own id).
// NO-AUTO-FIRE is preserved: a preview only ever fires on the operator's explicit
// Approve click, which reaches `/api/cockpit/preview/decide`. Claude may write a
// `review` annotation but CANNOT execute.
// ---------------------------------------------------------------------------

/** Insert an operator 'preview' row (awaiting the operator's decision). */
export async function createPreview(
  input: {
    sessionId: string;
    kind: PendingActionKind;
    mode: TradingMode;
    proposal: PendingActionProposal;
    /** Optional idempotency key (e.g. hash of a leader_action.id) — the partial-unique
     *  index on pending_actions.dedupe_key rejects a duplicate stage. */
    dedupeKey?: string;
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
      status: 'preview',
      origin: 'operator',
      dedupe_key: input.dedupeKey ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(`createPreview failed: ${error.message}`);
  return toPendingAction(data as PendingActionRow);
}

/** Open previews across all sessions (for the review-previews skill). */
export async function listOpenPreviews(
  client: SupabaseClient = getServiceRoleClient(),
): Promise<PendingAction[]> {
  const { data, error } = await client
    .from('pending_actions')
    .select('*')
    .eq('status', 'preview')
    .eq('origin', 'operator')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`listOpenPreviews failed: ${error.message}`);
  return (data as PendingActionRow[]).map(toPendingAction);
}

/** Attach Claude's review annotation to a preview (advisory; never executes). */
export async function attachPreviewReview(
  id: string,
  review: PendingActionReview,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<boolean> {
  const { data, error } = await client
    .from('pending_actions')
    .update({ review })
    .eq('id', id)
    .eq('status', 'preview')
    .eq('origin', 'operator')
    .select('id');
  if (error) throw new Error(`attachPreviewReview failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/**
 * ATOMIC CLAIM: flip an operator preview→'executing', optionally stamping the
 * operator-chosen (already-validated) leverage onto the proposal in the SAME
 * update. Guarded on `status='preview' AND origin='operator'` so exactly one
 * caller wins — a double-click or a skill 'pending' row posted here returns
 * false (no claim, no execution). Returns the CLAIMED action (with the stamped
 * leverage) when this call won the claim, else null.
 *
 * This is the anti-double-fire guard: the in-route executor runs ONLY after a
 * successful claim, and the proposal's clientIntentId (minted at preview
 * creation) is the second backstop — a duplicate intent dedupes in persistFill.
 */
export async function claimPreviewForExecute(
  id: string,
  validatedLeverage: number | null,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<PendingAction | null> {
  const current = await getPendingAction(id, client);
  if (!current || current.status !== 'preview' || current.origin !== 'operator') return null;

  const isOpening = current.proposal.intent.reduceOnly !== true;
  const stampLev = validatedLeverage !== null && isOpening;
  const nextProposal: PendingActionProposal = {
    intent: { ...current.proposal.intent, ...(stampLev ? { leverage: validatedLeverage } : {}) },
    display: { ...current.proposal.display, ...(stampLev ? { leverage: validatedLeverage } : {}) },
  };

  const { data, error } = await client
    .from('pending_actions')
    // Stamp decided_at = claim time so the reaper can age a row that gets stuck
    // 'executing' (serverless death before finalize/revert). finalize overwrites
    // it with the real decision time; revert clears it.
    .update({ status: 'executing', proposal: nextProposal, decided_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'preview')
    .eq('origin', 'operator')
    .select('*');
  if (error) throw new Error(`claimPreviewForExecute failed: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) return null;
  return toPendingAction(data[0] as PendingActionRow);
}

/** Mark a claimed ('executing') preview 'executed' — the operator-path terminal. */
export async function finalizeExecutedPreview(
  id: string,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<void> {
  const { error } = await client
    .from('pending_actions')
    .update({ status: 'executed', decided_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'executing');
  if (error) throw new Error(`finalizeExecutedPreview failed: ${error.message}`);
}

/**
 * Revert a claimed ('executing') preview back to 'preview' when the in-route
 * execute FAILED — so the operator can retry. Safe because the proposal's stable
 * clientIntentId makes a retry idempotent (a fill that actually landed dedupes).
 */
export async function revertClaimedPreview(
  id: string,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<void> {
  const { error } = await client
    .from('pending_actions')
    .update({ status: 'preview', decided_at: null })
    .eq('id', id)
    .eq('status', 'executing');
  if (error) throw new Error(`revertClaimedPreview failed: ${error.message}`);
}

/**
 * Recover rows stuck in 'executing' — the rare case where the serverless function
 * died AFTER the atomic claim (preview→executing) but BEFORE the catch could
 * revert (or finalize). Such a row is invisible to the operator (the preview
 * selector only surfaces 'preview') and otherwise unrecoverable (claim/discard
 * guard on 'preview'). This reverts any operator 'executing' row whose claim is
 * older than `ttlMs` back to 'preview' so it reappears and can be retried or
 * discarded.
 *
 * SAFE: a genuinely in-flight execute completes in seconds — far under `ttlMs` —
 * so a live claim is never reaped; and even if a reaped row is re-executed, the
 * stable clientIntentId dedupes in persistFill (no double-fire). Returns the
 * number of rows reaped. Called opportunistically (cockpit load + preview
 * creation) — no cron needed. `now` is injectable for tests.
 */
export async function reapStaleExecutingPreviews(
  ttlMs = 120_000,
  client: SupabaseClient = getServiceRoleClient(),
  now: number = Date.now(),
): Promise<number> {
  const cutoff = new Date(now - ttlMs).toISOString();
  const { data, error } = await client
    .from('pending_actions')
    .update({ status: 'preview', decided_at: null })
    .eq('status', 'executing')
    .eq('origin', 'operator')
    .lt('decided_at', cutoff)
    .select('id');
  if (error) throw new Error(`reapStaleExecutingPreviews failed: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}

/** Discard a preview (operator declined) — preview→'rejected'. Never executes. */
export async function discardPreview(
  id: string,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<boolean> {
  const { data, error } = await client
    .from('pending_actions')
    .update({ status: 'rejected', decided_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'preview')
    .eq('origin', 'operator')
    .select('id');
  if (error) throw new Error(`discardPreview failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
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
