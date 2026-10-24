/** Draft creation and ladder reads. All writes use the service-role client. */
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
  /** Copy-thesis tag: the wallet this ladder follows (leader guard auto-disarm). */
  leaderAddress?: string | null;
  maxTotalNotionalUsd?: number | null;
  maxTotalLossUsd?: number | null;
  /** Drafter detection mark — every rung price is a fixed ratio of it (enables the
   *  draft re-anchor). Omit for manual drafts (structural levels; re-anchor refuses). */
  anchorPx?: number | null;
  expiresAtMs?: number | null;
  /** Optional activation-window start (epoch ms) — triggers evaluate only from here. */
  activeFromMs?: number | null;
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
    leaderAddress: r.leader_address ?? null,
    maxTotalNotionalUsd: r.max_total_notional_usd ?? null,
    maxTotalLossUsd: r.max_total_loss_usd ?? null,
    anchorPx: r.anchor_px ?? null,
    expiresAt: r.expires_at ?? null,
    activeFrom: r.active_from ?? null,
    armedAt: r.armed_at ?? null,
    disarmedAt: r.disarmed_at ?? null,
    disarmReason: r.disarm_reason ?? null,
    archivedAt: r.archived_at ?? null,
    expiryAlertAt: r.expiry_alert_at ?? null,
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
      leader_address: input.leaderAddress ?? null,
      max_total_notional_usd: input.maxTotalNotionalUsd ?? null,
      max_total_loss_usd: input.maxTotalLossUsd ?? null,
      anchor_px: input.anchorPx ?? null,
      expires_at: input.expiresAtMs != null ? new Date(input.expiresAtMs).toISOString() : null,
      active_from: input.activeFromMs != null ? new Date(input.activeFromMs).toISOString() : null,
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
