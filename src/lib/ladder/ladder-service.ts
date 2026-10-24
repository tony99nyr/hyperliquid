/** Public ladder persistence API. Draft CRUD lives in ladder-crud-service. */
import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import type { ReanchorRungPatch } from './ladder-reanchor-business-logic';
export {
  createLadder,
  getLadderWithRungs,
  listLadders,
  listLaddersWithRungs,
} from './ladder-crud-service';
export type { NewRung, CreateLadderInput, ListLaddersOpts } from './ladder-crud-service';

/**
 * Arm a DRAFT ladder: status→'armed', stamp armed_at + the precondition hash + expiry,
 * and set each rung's deterministic cloid. CONDITIONAL on the row still being a draft
 * (the `.eq('status','draft')` guard makes a double-arm a no-op) AND on `updated_at`
 * still matching what the arm route READ (optimistic concurrency, review 2026-10-04:
 * the route validates rungs, then awaits network calls — without this guard a
 * re-anchor could re-price the rungs inside that window and the arm would authorize
 * prices the operator never saw). Returns true if the transition happened, false if
 * it lost either race (non-draft, or edited since the read).
 */
export async function armLadder(
  id: string,
  args: { preconditionHash: string; expiresAtMs: number; cloidByRungId: Record<string, string>; expectedUpdatedAt: string },
): Promise<boolean> {
  const db = getServiceRoleClient();
  const { data, error } = await db
    .from('ladders')
    .update({
      status: 'armed',
      armed_at: new Date().toISOString(),
      precondition_hash: args.preconditionHash,
      expires_at: new Date(args.expiresAtMs).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'draft') // only a draft can be armed — idempotent guard
    .eq('updated_at', args.expectedUpdatedAt) // only the exact row version the operator reviewed
    .select('id');
  if (error) throw new Error(`armLadder failed: ${error.message}`);
  if (!data || data.length === 0) return false; // already armed/disarmed — no transition

  for (const [rungId, cloid] of Object.entries(args.cloidByRungId)) {
    const { error: cErr } = await db.from('ladder_rungs').update({ cloid }).eq('id', rungId);
    if (cErr) throw new Error(`armLadder cloid set failed: ${cErr.message}`);
  }
  return true;
}

/**
 * Release an OCO group claim after a NO-FILL open (no exposure was opened). The failed
 * rung's own dedupe row still blocks it, so no double-fire window reopens, and the
 * sibling leg stays eligible. Never call this after a fill: money moved, keep the claim.
 */
export async function releaseOcoClaim(ocoGroupId: string, ladderId: string, rungId: string): Promise<void> {
  const db = getServiceRoleClient();
  const { data, error } = await db.rpc('release_oco_ladder_claim', {
    p_group_id: ocoGroupId, p_ladder_id: ladderId, p_rung_id: rungId,
  });
  if (error || data == null) throw new Error(`releaseOcoClaim failed: ${error?.message ?? 'no result'}`);
}

/** Claim a rung once through the unique fire key, or atomically claim its OCO group. */
export async function claimRungFire(ladderId: string, rungId: string, dedupeSuffix?: string, ocoGroupId?: string | null): Promise<{ claimed: boolean; fireId: string | null }> {
  const db = getServiceRoleClient();
  // TRAIL rungs pass a per-candle suffix: one claim per completed candle instead of
  // one-shot (the trail re-fires as price advances; every OTHER rung stays one-shot).
  const key = dedupeSuffix ? `${ladderId}:${rungId}:${dedupeSuffix}` : `${ladderId}:${rungId}`;
  if (ocoGroupId) {
    const { data, error } = await db.rpc('claim_oco_ladder_fire', { p_ladder_id: ladderId, p_rung_id: rungId, p_dedupe_key: key });
    if (error) throw new Error(`claimRungFire failed: ${error.message}`);
    return { claimed: data != null, fireId: data as string | null };
  }
  const { data, error } = await db
    .from('ladder_fires')
    .upsert(
      { ladder_id: ladderId, rung_id: rungId, dedupe_key: key, status: 'claimed' },
      { onConflict: 'dedupe_key', ignoreDuplicates: true },
    )
    .select('id');
  if (error) throw new Error(`claimRungFire failed: ${error.message}`);
  if (data && data.length > 0) return { claimed: true, fireId: data[0].id as string };
  return { claimed: false, fireId: null }; // already claimed (conflict → no row)
}

/** Record the terminal outcome of a claimed fire. */
export async function markFireOutcome(fireId: string, status: 'filled' | 'failed' | 'flattened' | 'skipped', detail?: string): Promise<void> {
  const db = getServiceRoleClient();
  const { error } = await db.from('ladder_fires').update({ status, detail: detail ?? null }).eq('id', fireId);
  if (error) throw new Error(`markFireOutcome failed: ${error.message}`);
}

/** Set a rung's status (fired / skipped / failed / cancelled). */
export async function setRungStatus(rungId: string, status: 'fired' | 'skipped' | 'failed' | 'cancelled'): Promise<void> {
  const db = getServiceRoleClient();
  const { error } = await db.from('ladder_rungs').update({ status }).eq('id', rungId);
  if (error) throw new Error(`setRungStatus failed: ${error.message}`);
}

/**
 * Mark a ladder DONE — its plan is fully executed (every rung reached a terminal status).
 * CONDITIONAL on the ladder still being 'armed' (idempotent; a disarmed/expired ladder is
 * left as-is). The fired positions live on in Open Positions with their resting brackets;
 * ladder status no longer governs them — 'done' just tells the UI + watcher it's complete.
 */
export async function markLadderDone(id: string): Promise<void> {
  const db = getServiceRoleClient();
  const { error } = await db
    .from('ladders')
    .update({ status: 'done', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'armed');
  if (error) throw new Error(`markLadderDone failed: ${error.message}`);
}

/**
 * Mark an ARMED ladder EXPIRED (status → 'expired'). The fire path already refuses +
 * disarms an expired ladder lazily (when a trigger is met); this is the PROACTIVE sweep
 * the watcher runs each tick so an overdue ladder never keeps displaying as "armed" in
 * the UI. Armed-guarded (idempotent; terminal states are left as-is).
 */
export async function markLadderExpired(id: string): Promise<void> {
  const db = getServiceRoleClient();
  const { error } = await db
    .from('ladders')
    .update({ status: 'expired', disarmed_at: new Date().toISOString(), disarm_reason: 'expired', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'armed');
  if (error) throw new Error(`markLadderExpired failed: ${error.message}`);
}

/**
 * Soft-ARCHIVE a ladder — stamp archived_at so the active UI lists hide it, while the row
 * (+ rungs + ladder_fires) stays for the audit trail. CONDITIONAL on the ladder NOT being
 * 'armed' (an armed ladder is live authorization — never hide it) and not already archived.
 * Returns true if it transitioned, false if it was armed / already archived / absent.
 */
export async function archiveLadder(id: string): Promise<boolean> {
  const db = getServiceRoleClient();
  const { data, error } = await db
    .from('ladders')
    .update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .neq('status', 'armed') // never hide a live armed ladder
    .is('archived_at', null) // idempotent
    .select('id');
  if (error) throw new Error(`archiveLadder failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/**
 * OCO one-cancels-other: disarm every OTHER armed ladder in `groupId` (all but the one
 * that just fired). Returns the disarmed ladder ids. Only touches `status='armed'` rows —
 * a draft/done/already-disarmed sibling is left as-is. This NEVER opens/adds/moves money;
 * it only removes a sibling's pending authorization so a straddle can't fire both legs.
 * Returns [] when `groupId` is null/empty (an ungrouped ladder has no siblings).
 */
export async function disarmOcoSiblings(groupId: string | null, exceptLadderId: string, reason: string): Promise<string[]> {
  if (!groupId) return [];
  const db = getServiceRoleClient();
  const { data, error } = await db
    .from('ladders')
    .update({ status: 'disarmed', disarmed_at: new Date().toISOString(), disarm_reason: reason, updated_at: new Date().toISOString() })
    .eq('oco_group_id', groupId)
    .eq('status', 'armed')
    .neq('id', exceptLadderId)
    .select('id');
  if (error) throw new Error(`disarmOcoSiblings failed: ${error.message}`);
  return (data ?? []).map((r) => r.id as string);
}

/** Disarm a ladder (operator kill-switch or precondition drift): status→'disarmed'. */
export async function disarmLadder(id: string, reason: string): Promise<void> {
  const db = getServiceRoleClient();
  const { error } = await db
    .from('ladders')
    .update({ status: 'disarmed', disarmed_at: new Date().toISOString(), disarm_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`disarmLadder failed: ${error.message}`);
}

export interface DraftReanchorArgs {
  /** The live mark the plan was scaled to — becomes the stored anchor. */
  newAnchorPx: number;
  /** The FULL replacement thesis (route composes old thesis + the audit note). */
  thesis: string | null;
  patches: ReanchorRungPatch[];
}

/**
 * Apply a re-anchor to a DRAFT ladder: rewrite the rung prices + the stored anchor.
 * This is a DRAFT-ONLY edit — it moves no money and never touches a non-pending rung.
 *
 * The write is ONE Postgres transaction (reanchor_draft_ladder, migration 0044) under
 * a ladders-row lock, so it is all-or-nothing: no partially scaled draft can exist
 * (review 2026-10-04, High #2), and nothing interleaves mid-write. An arm racing a
 * re-anchor is handled on the ARM side: armLadder's `expectedUpdatedAt` guard refuses
 * any arm whose review read predates the re-anchor's updated_at bump.
 */
export async function applyDraftReanchor(id: string, args: DraftReanchorArgs): Promise<'applied' | 'not-draft' | 'not-found'> {
  const db = getServiceRoleClient();
  const { data, error } = await db.rpc('reanchor_draft_ladder', {
    p_ladder_id: id,
    p_new_anchor: args.newAnchorPx,
    p_thesis: args.thesis,
    p_patches: args.patches,
  });
  if (error) throw new Error(`applyDraftReanchor failed: ${error.message}`);
  if (data !== 'applied' && data !== 'not-draft' && data !== 'not-found') {
    throw new Error(`applyDraftReanchor: unexpected RPC result '${String(data)}'`);
  }
  return data;
}
