/**
 * Exchange-fill backfill (I/O) — books HL fills the cockpit ledger missed.
 *
 * Runs from the reconcile cron right after position reconciliation: fetches the
 * live account's recent HL fills, computes the missing per-order candidates via
 * the PURE fill-backfill-business-logic, attributes each to a live session, and
 * persists through the SAME seam as every executed trade (`persistFillRow` +
 * `applyFillToPositionRows`) — so the positions fold, realized P&L, and the
 * Performance ledger self-heal from the immutable fills history. Idempotent
 * twice over: dedupe by `hl_order_id` up front, and `persistFillRow`'s unique
 * `client_intent_id` guard behind it. Fail-soft throughout (a cron must not
 * crash); per-row failures skip that row and keep going.
 *
 * A backfilled row goes in with `hl_raw.foldPending: true`, and the marker is
 * cleared only after the positions fold succeeds. The dedupe treats the order as
 * booked, so without the marker a failed fold would never run again. Each run
 * re-folds every position that still has a marked row, inside or outside the HL window.
 *
 * LIVE-ONLY by construction: it reads the REAL account's fills and writes only
 * into live sessions. Paper fills always pass through `executeIntent`, so paper
 * ledgers cannot have this gap. Never branches on `fill.source` downstream —
 * the inserted rows are ordinary CanonicalFills (audit-tagged `source:'live'`).
 */

import 'server-only';
import { randomUUID } from 'node:crypto';
import { getServiceRoleClient } from './supabase-server';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { fetchRecentFills, type HlFill } from '@/lib/hyperliquid/hyperliquid-info-service';
import { persistFillRow, applyFillToPositionRows } from './fill-persistence-service';
import { writeAnalysisLog } from './analysis-log-service';
import { computeMissingFills, attributeSession, type BackfillCandidate } from './fill-backfill-business-logic';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';
import type { CanonicalFill } from '@/types/fill';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface BackfillSummary {
  skipped: boolean;
  reason?: string;
  /** HL fills scanned in the window. */
  scanned: number;
  /** Missing orders inserted into the ledger. */
  inserted: number;
  /** Missing orders with NO live session to attach to (left for a later run). */
  unattributed: number;
  /** Why a run that did not skip still did not heal (a failed HL read served from the
   *  cache, or rows that failed to book). Absent on a complete run. */
  incomplete?: string;
}

/** Default window: 48h. Every cron tick re-covers the window; dedupe makes that free. */
const DEFAULT_LOOKBACK_MS = 48 * 60 * 60 * 1000;

export async function backfillExchangeFills(
  opts: { lookbackMs?: number; client?: SupabaseClient } = {},
): Promise<BackfillSummary> {
  const addr = getHlAccountAddress();
  if (!addr) return { skipped: true, reason: 'HL_ACCOUNT_ADDRESS not set', scanned: 0, inserted: 0, unattributed: 0 };
  const client = opts.client ?? getServiceRoleClient();
  const lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;

  // 0) Finish the folds that earlier runs left. This needs only the database, so it
  //    runs before the HL read and also during an HL outage.
  const refold = await retryPendingFolds(client);

  // 1) The exchange's own fill history for the window. A failed read with nothing
  //    cached must be a no-op, never "no fills happened".
  const hl = await fetchRecentFills(addr, lookbackMs, 2000);
  if (hl.error && hl.fills.length === 0) {
    const skipped: BackfillSummary = { skipped: true, reason: `HL fills read failed: ${hl.error}`, scanned: 0, inserted: 0, unattributed: 0 };
    return refold ? { ...skipped, incomplete: refold } : skipped;
  }
  const summary = await bookMissingFills(hl.fills, client);
  // A failed read that fell back to an expired cache (the newest fills can be missing),
  // a pending fold, or rows that failed to book leave the run incomplete: the heartbeat
  // must not count it as healed.
  const why = [hl.error ? `HL fills read failed, used cached fills: ${hl.error}` : null, refold, summary.incomplete ?? null]
    .filter((w): w is string => w !== null)
    .join('; ');
  return why ? { ...summary, incomplete: why } : summary;
}

/** Steps 2 and up: book every exchange fill that the ledger is missing. */
async function bookMissingFills(fills: HlFill[], client: SupabaseClient): Promise<BackfillSummary> {
  const { failed, ...summary } = await insertMissingFills(fills, client);
  // An unattributed fill is unbooked, like the no-live-sessions skip. A late partial
  // (underBooked) is not counted: no run can book it, and it has its own alert.
  const why = [
    failed > 0 ? `${failed} fill(s) failed to book` : null,
    summary.unattributed > 0 ? `${summary.unattributed} fill(s) unattributed` : null,
  ]
    .filter((w): w is string => w !== null)
    .join('; ');
  return why ? { ...summary, incomplete: why } : summary;
}

/** Most marked rows one run re-folds: far above any real backlog, and below the
 *  PostgREST max_rows of 1000, so one query reads them. */
const PENDING_FOLD_LIMIT = 500;

/**
 * Re-fold every (session, coin) that has a backfilled row whose fold did not finish,
 * then clear the markers. The query does not depend on the HL fills window, so a
 * marker that outlives the window (a cron outage) is still found. Returns why the
 * run is incomplete, or null when every pending fold finished.
 */
async function retryPendingFolds(client: SupabaseClient): Promise<string | null> {
  type Row = { id: string; hl_order_id: string; session_id: string; coin: string; hl_raw: Record<string, unknown> };
  // Read one row past the limit to know whether more wait. Known limit: if more than
  // PENDING_FOLD_LIMIT rows keep failing, the rows after them wait too, and every run
  // reports incomplete until the cause is fixed.
  const { data, error } = await client
    .from('fills')
    .select('id, hl_order_id, session_id, coin, hl_raw')
    .contains('hl_raw', { foldPending: true })
    .order('id', { ascending: true })
    .limit(PENDING_FOLD_LIMIT + 1);
  if (error) return `pending folds read failed: ${error.message}`;
  const more = (data ?? []).length > PENDING_FOLD_LIMIT;
  const marked = ((data ?? []) as Row[]).slice(0, PENDING_FOLD_LIMIT);
  const byPosition = new Map<string, Row[]>();
  for (const r of marked) {
    const key = `${r.session_id}|${r.coin}`;
    byPosition.set(key, [...(byPosition.get(key) ?? []), r]);
  }
  let pending = 0;
  for (const rows of byPosition.values()) {
    try {
      // One fold covers every pending row of the position: the fold reads the whole ledger.
      await applyFillToPositionRows({ sessionId: rows[0].session_id, coin: rows[0].coin }, undefined, client);
    } catch {
      pending += rows.length;
      continue;
    }
    for (const r of rows) {
      // A failed clear leaves the marker, so the next run folds again: count it as pending.
      await clearFoldPending(client, String(r.hl_order_id), r.hl_raw).catch(() => pending++);
    }
  }
  const rest = more ? ' (more marked rows wait for the next run)' : '';
  return pending > 0 || more ? `${pending} fold(s) pending${rest}` : null;
}

/** Replace hl_raw with a copy that has no foldPending marker. */
async function clearFoldPending(client: SupabaseClient, hlOrderId: string, hlRaw: Record<string, unknown>): Promise<void> {
  const { foldPending: _pending, ...rest } = hlRaw;
  const { error } = await client.from('fills').update({ hl_raw: rest }).eq('hl_order_id', hlOrderId);
  if (error) throw new Error(`clear foldPending failed: ${error.message}`);
}

/** Insert and fold every exchange fill that the ledger is missing. */
async function insertMissingFills(fills: HlFill[], client: SupabaseClient): Promise<BackfillSummary & { failed: number }> {
  // 2) Which orders does the ledger already know, and at what booked size? Match
  //    on hl_order_id — executeIntent bookings and prior backfills both set it.
  //    Chunked: a 2000-oid `.in()` would blow the URL and PostgREST row caps.
  const oids = Array.from(new Set(fills.filter((f) => f.oid != null).map((f) => String(f.oid))));
  if (oids.length === 0) return { skipped: false, scanned: fills.length, inserted: 0, unattributed: 0, failed: 0 };
  const knownSzByOid = new Map<string, number>();
  for (let i = 0; i < oids.length; i += 200) {
    const { data: knownRows, error: knownErr } = await client
      .from('fills')
      .select('hl_order_id, sz')
      .in('hl_order_id', oids.slice(i, i + 200));
    if (knownErr) {
      return { skipped: true, reason: `fills dedupe read failed: ${knownErr.message}`, scanned: fills.length, inserted: 0, unattributed: 0, failed: 0 };
    }
    for (const r of knownRows ?? []) {
      const row = r as { hl_order_id: string | null; sz: number };
      const key = String(row.hl_order_id);
      knownSzByOid.set(key, (knownSzByOid.get(key) ?? 0) + Number(row.sz));
    }
  }

  const { candidates: missing, underBooked } = computeMissingFills(fills, knownSzByOid);
  // Late partials of an already-booked order CANNOT be inserted (one row per oid,
  // fills_hl_order_id_uniq) — surface the shortfall loudly instead of silently
  // under-counting; the operator reconciles by hand. Expected ~never at this
  // account's scale (brackets are stop-MARKET; only a resting LIMIT can split
  // across cron ticks).
  for (const u of underBooked) {
    await sendDiscord(
      `🚨 **FILL LEDGER SHORTFALL** — HL order ${u.hlOrderId} (${u.coin}) filled ${u.deltaSz} more than the ledger booked (late partial fills). The ledger cannot auto-book a second row for the same order; reconcile manually.`,
      'HL Reconcile',
    ).catch(() => {});
  }
  if (missing.length === 0) return { skipped: false, scanned: fills.length, inserted: 0, unattributed: 0, failed: 0 };

  // 3) Session attribution inputs (live sessions only).
  const { data: liveSessions } = await client
    .from('sessions')
    .select('id, status, created_at')
    .eq('mode', 'live')
    .order('created_at', { ascending: false });
  const liveIds = (liveSessions ?? []).map((s) => (s as { id: string }).id);
  if (liveIds.length === 0) {
    return { skipped: true, reason: 'no live sessions to attribute to', scanned: fills.length, inserted: 0, unattributed: missing.length, failed: 0 };
  }
  const newestActive = (liveSessions ?? []).find((s) => (s as { status: string }).status === 'active') as { id: string } | undefined;

  const holderByCoin: Record<string, string> = {};
  const { data: posRows } = await client
    .from('positions')
    .select('session_id, coin, side')
    .neq('side', 'flat')
    .in('session_id', liveIds);
  for (const r of posRows ?? []) {
    const row = r as { session_id: string; coin: string };
    holderByCoin[row.coin.trim().toUpperCase()] ??= row.session_id;
  }

  const lastTraderByCoin: Record<string, string> = {};
  const { data: lastFills } = await client
    .from('fills')
    .select('session_id, coin')
    .in('session_id', liveIds)
    .order('filled_at', { ascending: false })
    .limit(300);
  for (const r of lastFills ?? []) {
    const row = r as { session_id: string; coin: string };
    lastTraderByCoin[row.coin.trim().toUpperCase()] ??= row.session_id;
  }

  // 4) Insert oldest-first through the canonical persistence seam.
  let inserted = 0;
  let failed = 0;
  let unattributed = 0;
  for (const cand of missing) {
    const sessionId = attributeSession(cand.coin, holderByCoin, lastTraderByCoin, newestActive?.id ?? null);
    if (!sessionId) {
      unattributed++;
      continue;
    }
    const fill: CanonicalFill = {
      clientIntentId: randomUUID(),
      sessionId,
      coin: cand.coin,
      side: cand.side,
      px: cand.px,
      sz: cand.sz,
      notionalUsd: cand.notionalUsd,
      feeUsd: cand.feeUsd,
      reduceOnly: cand.reduceOnly,
      partial: false,
      source: 'live',
      hlOrderId: cand.hlOrderId,
      hlRaw: { backfill: true, foldPending: true, rows: cand.rawRows },
      filledAt: cand.filledAt,
    };
    try {
      const fresh = await persistFillRow(fill, client);
      if (!fresh) {
        // A raced writer booked this order first, maybe under another session. Fold the
        // session and coin of the row that the ledger holds, not this run's attribution.
        const { data: held, error: heldErr } = await client
          .from('fills')
          .select('session_id, coin, hl_raw')
          .eq('hl_order_id', cand.hlOrderId)
          .maybeSingle();
        if (heldErr) throw new Error(`duplicate fill read failed: ${heldErr.message}`);
        const row = held as { session_id: string; coin: string; hl_raw: Record<string, unknown> | null } | null;
        if (!row) throw new Error(`duplicate fill row for oid ${cand.hlOrderId} not found`);
        // Dedupe skips this order from now on, so mark the held row before the fold and
        // clear it after: a fold that fails or never finishes leaves it for the retry pass.
        const heldRaw = { ...(row.hl_raw ?? {}), foldPending: true };
        const { error: markErr } = await client.from('fills').update({ hl_raw: heldRaw }).eq('hl_order_id', cand.hlOrderId);
        // Fold even when the mark failed: the fold does not need the marker.
        await applyFillToPositionRows({ sessionId: row.session_id, coin: row.coin }, undefined, client);
        if (markErr) continue; // folded, and there is no marker to clear
        await clearFoldPending(client, cand.hlOrderId, heldRaw).catch(() => {});
        continue;
      }
      await applyFillToPositionRows(fill, undefined, client);
      // The fold succeeded: clear the marker. If the clear fails, the next run
      // re-folds once more (idempotent), so the row is still booked and counted.
      await clearFoldPending(client, cand.hlOrderId, fill.hlRaw ?? {}).catch(() => {});
      inserted++;
      await writeAnalysisLog({
        sessionId,
        source: 'reconcile',
        severity: 'info',
        message: `FILL BACKFILL: booked exchange-side ${cand.side} ${cand.sz} ${cand.coin} @ $${cand.px.toFixed(4)} (oid ${cand.hlOrderId}, ${describe(cand)}) the ledger had missed.`,
      }).catch(() => {});
    } catch {
      // fail-soft per row. A failed insert leaves no row, so the next run inserts it
      // again; a failed fold leaves foldPending set, so the next run re-folds it.
      failed++;
    }
  }
  return { skipped: false, scanned: fills.length, inserted, unattributed, failed };
}

function describe(c: BackfillCandidate): string {
  return c.reduceOnly ? 'exchange-side close' : 'exchange-side open/add';
}
