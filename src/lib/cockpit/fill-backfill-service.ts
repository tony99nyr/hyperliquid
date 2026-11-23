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
 * Each run first re-folds every live position whose ledger holds more fills than
 * its last fold saw (`list_unfolded_live_positions`, migration 0053). That finds a
 * fold that failed after its fill committed, from any writer (executeIntent, this
 * backfill, a raced duplicate), inside or outside the HL window, with no marker.
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

  // 0) Finish the folds that failed earlier, from any writer. This needs only the
  //    database, so it runs before the HL read and also during an HL outage.
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

/** Most positions one run re-folds: far above any real backlog. */
const PENDING_FOLD_LIMIT = 200;

/**
 * Re-fold every live (session, coin) whose ledger is ahead of its positions row.
 * The check compares counts in the database, so it does not depend on the HL fills
 * window or on which writer's fold failed. Returns why the run is incomplete, or
 * null when no fold is pending.
 */
async function retryPendingFolds(client: SupabaseClient): Promise<string | null> {
  // Read one past the limit to know whether more wait.
  const { data, error } = await client.rpc('list_unfolded_live_positions', { p_limit: PENDING_FOLD_LIMIT + 1 });
  if (error) return `pending folds read failed: ${error.message}`;
  const rows = (data ?? []) as Array<{ session_id: string; coin: string }>;
  const more = rows.length > PENDING_FOLD_LIMIT;
  let pending = 0;
  let lastError = '';
  for (const r of rows.slice(0, PENDING_FOLD_LIMIT)) {
    await applyFillToPositionRows({ sessionId: r.session_id, coin: r.coin }, { client }).catch((err: unknown) => {
      pending++;
      lastError = err instanceof Error ? err.message : String(err);
    });
  }
  // Name the last error, so a permanent fault (a missing function) shows in the summary.
  const why = lastError ? `, last error: ${lastError}` : '';
  const rest = more ? ' (more positions wait for the next run)' : '';
  return pending > 0 || more ? `${pending} fold(s) pending${why}${rest}` : null;
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
      hlRaw: { backfill: true, rows: cand.rawRows },
      filledAt: cand.filledAt,
    };
    try {
      const fresh = await persistFillRow(fill, client);
      if (!fresh) {
        // A raced writer booked this order first, maybe under another session. Fold the
        // session and coin of the row that the ledger holds, not this run's attribution.
        const { data: held, error: heldErr } = await client
          .from('fills')
          .select('session_id, coin')
          .eq('hl_order_id', cand.hlOrderId)
          .maybeSingle();
        if (heldErr) throw new Error(`duplicate fill read failed: ${heldErr.message}`);
        const row = held as { session_id: string; coin: string } | null;
        if (!row) throw new Error(`duplicate fill row for oid ${cand.hlOrderId} not found`);
        // A failed read or fold here is safe: the held row's ledger is then ahead of
        // its positions row, and the next run's retryPendingFolds re-folds it.
        await applyFillToPositionRows({ sessionId: row.session_id, coin: row.coin }, { client });
        continue;
      }
      await applyFillToPositionRows(fill, { client });
      inserted++;
      await writeAnalysisLog({
        sessionId,
        source: 'reconcile',
        severity: 'info',
        message: `FILL BACKFILL: booked exchange-side ${cand.side} ${cand.sz} ${cand.coin} @ $${cand.px.toFixed(4)} (oid ${cand.hlOrderId}, ${describe(cand)}) the ledger had missed.`,
      }).catch(() => {});
    } catch {
      // fail-soft per row. A failed insert leaves no row, so the next run inserts it
      // again; a failed fold leaves the ledger ahead, so the next run re-folds it.
      failed++;
    }
  }
  return { skipped: false, scanned: fills.length, inserted, unattributed, failed };
}

function describe(c: BackfillCandidate): string {
  return c.reduceOnly ? 'exchange-side close' : 'exchange-side open/add';
}
