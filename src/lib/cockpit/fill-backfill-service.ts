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
 * LIVE-ONLY by construction: it reads the REAL account's fills and writes only
 * into live sessions. Paper fills always pass through `executeIntent`, so paper
 * ledgers cannot have this gap. Never branches on `fill.source` downstream —
 * the inserted rows are ordinary CanonicalFills (audit-tagged `source:'live'`).
 */

import 'server-only';
import { randomUUID } from 'node:crypto';
import { getServiceRoleClient } from './supabase-server';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { fetchRecentFills } from '@/lib/hyperliquid/hyperliquid-info-service';
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

  // 1) The exchange's own fill history for the window. A failed read with nothing
  //    cached must be a no-op, never "no fills happened".
  const hl = await fetchRecentFills(addr, lookbackMs, 2000);
  if (hl.error && hl.fills.length === 0) {
    return { skipped: true, reason: `HL fills read failed: ${hl.error}`, scanned: 0, inserted: 0, unattributed: 0 };
  }

  // 2) Which orders does the ledger already know, and at what booked size? Match
  //    on hl_order_id — executeIntent bookings and prior backfills both set it.
  //    Chunked: a 2000-oid `.in()` would blow the URL and PostgREST row caps.
  const oids = Array.from(new Set(hl.fills.filter((f) => f.oid != null).map((f) => String(f.oid))));
  if (oids.length === 0) return { skipped: false, scanned: hl.fills.length, inserted: 0, unattributed: 0 };
  const knownSzByOid = new Map<string, number>();
  for (let i = 0; i < oids.length; i += 200) {
    const { data: knownRows, error: knownErr } = await client
      .from('fills')
      .select('hl_order_id, sz')
      .in('hl_order_id', oids.slice(i, i + 200));
    if (knownErr) {
      return { skipped: true, reason: `fills dedupe read failed: ${knownErr.message}`, scanned: hl.fills.length, inserted: 0, unattributed: 0 };
    }
    for (const r of knownRows ?? []) {
      const row = r as { hl_order_id: string | null; sz: number };
      const key = String(row.hl_order_id);
      knownSzByOid.set(key, (knownSzByOid.get(key) ?? 0) + Number(row.sz));
    }
  }

  const { candidates: missing, underBooked } = computeMissingFills(hl.fills, knownSzByOid);
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
  if (missing.length === 0) return { skipped: false, scanned: hl.fills.length, inserted: 0, unattributed: 0 };

  // 3) Session attribution inputs (live sessions only).
  const { data: liveSessions } = await client
    .from('sessions')
    .select('id, status, created_at')
    .eq('mode', 'live')
    .order('created_at', { ascending: false });
  const liveIds = (liveSessions ?? []).map((s) => (s as { id: string }).id);
  if (liveIds.length === 0) {
    return { skipped: true, reason: 'no live sessions to attribute to', scanned: hl.fills.length, inserted: 0, unattributed: missing.length };
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
      // Fold EVEN when the insert was a duplicate (raced writer, or a prior run
      // that crashed between insert and fold) — the fold is idempotent by
      // construction, so re-running it is free and self-heals the half-applied case.
      await applyFillToPositionRows(fill, undefined, client);
      if (!fresh) continue;
      inserted++;
      await writeAnalysisLog({
        sessionId,
        source: 'reconcile',
        severity: 'info',
        message: `FILL BACKFILL: booked exchange-side ${cand.side} ${cand.sz} ${cand.coin} @ $${cand.px.toFixed(4)} (oid ${cand.hlOrderId}, ${describe(cand)}) the ledger had missed.`,
      }).catch(() => {});
    } catch {
      // fail-soft per row; the next run retries it (dedupe keeps it exact)
    }
  }
  return { skipped: false, scanned: hl.fills.length, inserted, unattributed };
}

function describe(c: BackfillCandidate): string {
  return c.reduceOnly ? 'exchange-side close' : 'exchange-side open/add';
}
