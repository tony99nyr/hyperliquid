/**
 * Armed Ladder persistence (SERVICE ROLE, server-only).
 *
 * CRUD for ladders / ladder_rungs. The UI reads via the anon client (select-only RLS);
 * ALL writes go through the admin-authed arm/author routes that call this. Arming is an
 * AUTHORIZATION transition (draft→armed) — it moves NO money; the fire route (P1d) is the
 * only path that executes. The §3.6 DB CHECK is the backstop: this service never sets a
 * scout-authored ladder to live/armed (the routes refuse it; the DB refuses it too).
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import type {
  Ladder,
  LadderRung,
  LadderWithRungs,
  LadderAuthor,
  LadderMode,
  LadderSide,
  RungAction,
  RungTriggerKind,
  RungTriggerMeta,
} from './ladder-types';

/** A rung as supplied at create-time (no id/status/cloid yet). */
export interface NewRung {
  seq: number;
  coin: string;
  side: LadderSide;
  action: RungAction;
  triggerKind: RungTriggerKind;
  triggerPx?: number | null;
  triggerMeta?: RungTriggerMeta | null;
  sizeCoins?: number | null;
  /** reduce/close ONLY: fraction (0,1] of the CURRENT live position to trim at fire. */
  reduceFrac?: number | null;
  riskUsd?: number | null;
  stopFrac?: number | null;
  leverage?: number | null;
  stopPx?: number | null;
  targetPx?: number | null;
}

export interface CreateLadderInput {
  title: string;
  thesis?: string | null;
  /** Defaults to 'operator'. A 'scout' author is forced to paper by the DB CHECK. */
  author?: LadderAuthor;
  /** Defaults to 'paper'. */
  mode?: LadderMode;
  /** OCO group id — share it across a straddle's two ladders to link them (one fires →
   *  the other auto-disarms). null/omitted = standalone. */
  ocoGroupId?: string | null;
  maxTotalNotionalUsd?: number | null;
  maxTotalLossUsd?: number | null;
  expiresAtMs?: number | null;
  rungs: NewRung[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToLadder(r: any): Ladder {
  return {
    id: r.id,
    title: r.title,
    thesis: r.thesis ?? null,
    author: r.author,
    mode: r.mode,
    status: r.status,
    preconditionHash: r.precondition_hash ?? null,
    ocoGroupId: r.oco_group_id ?? null,
    maxTotalNotionalUsd: r.max_total_notional_usd ?? null,
    maxTotalLossUsd: r.max_total_loss_usd ?? null,
    expiresAt: r.expires_at ?? null,
    armedAt: r.armed_at ?? null,
    disarmedAt: r.disarmed_at ?? null,
    disarmReason: r.disarm_reason ?? null,
    archivedAt: r.archived_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToRung(r: any): LadderRung {
  return {
    id: r.id,
    ladderId: r.ladder_id,
    seq: r.seq,
    coin: r.coin,
    side: r.side,
    action: r.action,
    triggerKind: r.trigger_kind,
    triggerPx: r.trigger_px ?? null,
    triggerMeta: (r.trigger_meta ?? null) as RungTriggerMeta | null,
    sizeCoins: r.size_coins ?? null,
    reduceFrac: r.reduce_frac ?? null,
    riskUsd: r.risk_usd ?? null,
    stopFrac: r.stop_frac ?? null,
    leverage: r.leverage ?? null,
    stopPx: r.stop_px ?? null,
    targetPx: r.target_px ?? null,
    status: r.status,
    cloid: r.cloid ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Insert a DRAFT ladder + its rungs (one transaction-ish: ladder first, then rungs;
 *  on a rung-insert failure the partial ladder is cleaned up). Returns the new id. */
export async function createLadder(input: CreateLadderInput): Promise<string> {
  const db = getServiceRoleClient();
  const { data: led, error: ladderErr } = await db
    .from('ladders')
    .insert({
      title: input.title,
      thesis: input.thesis ?? null,
      author: input.author ?? 'operator',
      mode: input.mode ?? 'paper',
      status: 'draft',
      oco_group_id: input.ocoGroupId ?? null,
      max_total_notional_usd: input.maxTotalNotionalUsd ?? null,
      max_total_loss_usd: input.maxTotalLossUsd ?? null,
      expires_at: input.expiresAtMs != null ? new Date(input.expiresAtMs).toISOString() : null,
    })
    .select('id')
    .single();
  if (ladderErr || !led) throw new Error(`createLadder failed: ${ladderErr?.message ?? 'no row'}`);
  const ladderId = led.id as string;

  const rungRows = input.rungs.map((r) => ({
    ladder_id: ladderId,
    seq: r.seq,
    coin: r.coin.trim().toUpperCase(),
    side: r.side,
    action: r.action,
    trigger_kind: r.triggerKind,
    trigger_px: r.triggerPx ?? null,
    trigger_meta: r.triggerMeta ?? null,
    size_coins: r.sizeCoins ?? null,
    reduce_frac: r.reduceFrac ?? null,
    risk_usd: r.riskUsd ?? null,
    stop_frac: r.stopFrac ?? null,
    leverage: r.leverage ?? null,
    stop_px: r.stopPx ?? null,
    target_px: r.targetPx ?? null,
    status: 'pending',
  }));
  const { error: rungErr } = await db.from('ladder_rungs').insert(rungRows);
  if (rungErr) {
    // Don't leave an orphan ladder with no rungs — the cascade cleans the rungs too.
    await db.from('ladders').delete().eq('id', ladderId);
    throw new Error(`createLadder rungs failed: ${rungErr.message}`);
  }
  return ladderId;
}

/** Load a ladder + its rungs (seq order), or null if absent. */
export async function getLadderWithRungs(id: string): Promise<LadderWithRungs | null> {
  const db = getServiceRoleClient();
  const { data: led, error } = await db.from('ladders').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`getLadderWithRungs failed: ${error.message}`);
  if (!led) return null;
  const { data: rungs, error: rErr } = await db.from('ladder_rungs').select('*').eq('ladder_id', id).order('seq', { ascending: true });
  if (rErr) throw new Error(`getLadderWithRungs rungs failed: ${rErr.message}`);
  return { ...rowToLadder(led), rungs: (rungs ?? []).map(rowToRung) };
}

/** Options for the list queries. `archived` selects which side of the soft-archive line:
 *  false/undefined = ACTIVE only (the default the UI shows); true = ARCHIVED only (audit view). */
export interface ListLaddersOpts {
  archived?: boolean;
}

/** List ladders (newest first), optionally filtered by status. Excludes archived by
 *  default (set opts.archived to view the archived audit list instead). */
export async function listLadders(status?: Ladder['status'], opts?: ListLaddersOpts): Promise<Ladder[]> {
  const db = getServiceRoleClient();
  let q = db.from('ladders').select('*').order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  q = opts?.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null);
  const { data, error } = await q;
  if (error) throw new Error(`listLadders failed: ${error.message}`);
  return (data ?? []).map(rowToLadder);
}

/** List ladders WITH their rungs (newest first), optionally filtered by status. One
 *  ladder query + one rungs query (not N+1) — the cockpit's armed-ladder panel reads this. */
export async function listLaddersWithRungs(status?: Ladder['status'], opts?: ListLaddersOpts): Promise<LadderWithRungs[]> {
  const db = getServiceRoleClient();
  const ladders = await listLadders(status, opts);
  if (ladders.length === 0) return [];
  const ids = ladders.map((l) => l.id);
  const { data, error } = await db.from('ladder_rungs').select('*').in('ladder_id', ids).order('seq', { ascending: true });
  if (error) throw new Error(`listLaddersWithRungs rungs failed: ${error.message}`);
  const byLadder = new Map<string, LadderRung[]>();
  for (const row of data ?? []) {
    const r = rowToRung(row);
    (byLadder.get(r.ladderId) ?? byLadder.set(r.ladderId, []).get(r.ladderId)!).push(r);
  }
  return ladders.map((l) => ({ ...l, rungs: byLadder.get(l.id) ?? [] }));
}

/**
 * Arm a DRAFT ladder: status→'armed', stamp armed_at + the precondition hash + expiry,
 * and set each rung's deterministic cloid. CONDITIONAL on the row still being a draft
 * (the `.eq('status','draft')` guard makes a double-arm a no-op). Returns true if the
 * transition happened, false if it was already non-draft (lost the race).
 */
export async function armLadder(
  id: string,
  args: { preconditionHash: string; expiresAtMs: number; cloidByRungId: Record<string, string> },
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
 * Idempotently CLAIM a rung fire — the atomic double-fire guard. Inserts a
 * ladder_fires row keyed by the unique dedupe_key (= ladderId:rungId) with ON CONFLICT
 * DO NOTHING. Returns claimed=true ONLY for the caller that inserted the row; a
 * concurrent/retried fire of the same rung gets claimed=false and must NOT execute.
 */
export async function claimRungFire(ladderId: string, rungId: string): Promise<{ claimed: boolean; fireId: string | null }> {
  const db = getServiceRoleClient();
  const { data, error } = await db
    .from('ladder_fires')
    .upsert(
      { ladder_id: ladderId, rung_id: rungId, dedupe_key: `${ladderId}:${rungId}`, status: 'claimed' },
      { onConflict: 'dedupe_key', ignoreDuplicates: true },
    )
    .select('id');
  if (error) throw new Error(`claimRungFire failed: ${error.message}`);
  if (data && data.length > 0) return { claimed: true, fireId: data[0].id as string };
  return { claimed: false, fireId: null }; // already claimed (conflict → no row)
}

/** Record the terminal outcome of a claimed fire (filled / failed / flattened). */
export async function markFireOutcome(fireId: string, status: 'filled' | 'failed' | 'flattened', detail?: string): Promise<void> {
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
