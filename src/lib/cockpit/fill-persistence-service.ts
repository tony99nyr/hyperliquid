/**
 * Fill → DB persistence (I/O). The mode-AGNOSTIC half of the seam: it consumes a
 * CanonicalFill (from either the paper book-match or a live HL confirmation) and
 * writes the durable cockpit rows. It NEVER reads `fill.source`.
 *
 *   persistFillRow(fill)           → fills row, idempotent on client_intent_id
 *   applyFillToPositionRows(fill)  → load position → fold (pure nextPosition)
 *                                    → upsert positions row + insert pnl row
 *
 * Idempotency: the `fills.client_intent_id` unique constraint means a duplicate
 * insert raises Postgres 23505 (unique_violation); we swallow that so calling
 * executeIntent twice with the same intent records the fill exactly once.
 */

import { getServiceRoleClient } from './supabase-server';
import {
  buildFillRow,
  buildPnlRow,
  buildPositionRow,
  positionFromRow,
} from './cockpit-rows-business-logic';
import { applyFill, emptyPosition } from '@/lib/trading/pnl-business-logic';
import type { CanonicalFill } from '@/types/fill';
import type { Position } from '@/types/position';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Postgres unique_violation — a duplicate client_intent_id. */
const PG_UNIQUE_VIOLATION = '23505';

/** True when an error indicates a duplicate fill row (idempotent re-run). */
function isDuplicateFill(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === PG_UNIQUE_VIOLATION) return true;
  // Some PostgREST surfaces only carry the message; match the constraint name.
  return /duplicate key|client_intent_id/i.test(error.message ?? '');
}

/**
 * Load the current position for (session, coin), or null when none exists yet.
 * Read-only. Used by advise-exit to build a reduce-only intent against the real
 * open size. Returns null (rather than throwing) when Supabase is unconfigured.
 */
export async function loadPosition(
  sessionId: string,
  coin: string,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<Position | null> {
  const { data, error } = await client
    .from('positions')
    .select('coin, side, sz, avg_entry_px, realized_pnl_usd, fees_paid_usd')
    .eq('session_id', sessionId)
    .eq('coin', coin.trim().toUpperCase())
    .maybeSingle();
  if (error) throw new Error(`loadPosition failed: ${error.message}`);
  if (!data) return null;
  return positionFromRow(data as Parameters<typeof positionFromRow>[0]);
}

/**
 * Persist a canonical fill as a `fills` row. Idempotent: a duplicate
 * client_intent_id is silently treated as already-recorded (returns false).
 * Returns true when a new row was inserted.
 */
export async function persistFillRow(
  fill: CanonicalFill,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<boolean> {
  const row = buildFillRow(fill);
  const { error } = await client.from('fills').insert(row);
  if (error) {
    if (isDuplicateFill(error)) return false; // already recorded — idempotent
    throw new Error(`persistFillRow failed: ${error.message}`);
  }
  return true;
}

/**
 * Load the current position for (session, coin), fold the fill in via the PURE
 * `nextPosition`, upsert the positions row, and insert a pnl snapshot row.
 * Returns the new position. Mode-agnostic — never inspects `fill.source`.
 */
export async function applyFillToPositionRows(
  fill: CanonicalFill,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<Position> {
  // 1. Load the prior position (if any) for this session+coin.
  const { data: priorRow, error: loadError } = await client
    .from('positions')
    .select('coin, side, sz, avg_entry_px, realized_pnl_usd, fees_paid_usd')
    .eq('session_id', fill.sessionId)
    .eq('coin', fill.coin)
    .maybeSingle();
  if (loadError) throw new Error(`applyFillToPositionRows load failed: ${loadError.message}`);

  const prior = priorRow
    ? positionFromRow(priorRow as Parameters<typeof positionFromRow>[0])
    : undefined;

  // 2. Pure fold — identical math regardless of source. (Same fold as
  // position-tracker.nextPosition; inlined here to keep imports one-directional.)
  const next = applyFill(prior ?? emptyPosition(fill.coin), fill);

  // 3. Upsert the positions row (unique on session_id+coin).
  const positionRow = buildPositionRow(fill.sessionId, next, new Date().toISOString());
  const { error: upsertError } = await client
    .from('positions')
    .upsert(positionRow, { onConflict: 'session_id,coin' });
  if (upsertError) throw new Error(`applyFillToPositionRows upsert failed: ${upsertError.message}`);

  // 4. Append a pnl snapshot (realized + fees; unrealized needs a mark, left 0).
  const pnlRow = buildPnlRow(fill.sessionId, next);
  const { error: pnlError } = await client.from('pnl').insert(pnlRow);
  if (pnlError) throw new Error(`applyFillToPositionRows pnl insert failed: ${pnlError.message}`);

  return next;
}
