/**
 * Fill → DB persistence (I/O). The mode-AGNOSTIC half of the seam: it consumes a
 * CanonicalFill (from either the paper book-match or a live HL confirmation) and
 * writes the durable cockpit rows. It NEVER reads `fill.source`.
 *
 *   persistFillRow(fill)           → fills row, idempotent on client_intent_id
 *   applyFillToPositionRows(fill)  → fold ALL fills for (session, coin) from the
 *                                    ledger (pure applyFills) → upsert positions
 *                                    row + insert pnl row
 *
 * Idempotency + crash-consistency (ADR-0001): the `fills` table is the single
 * source of truth. `fills.client_intent_id` is unique, so a duplicate insert
 * raises Postgres 23505 (unique_violation) and is swallowed — a fill is recorded
 * exactly once no matter how many times executeIntent runs. The position is then
 * RECOMPUTED by folding the whole ledger rather than incrementally mutated, so:
 *   - re-running executeIntent with the same intent converges to the same
 *     position (no double-counting — the duplicate fill never reaches the ledger);
 *   - a crash between the fills insert and the position upsert self-heals on the
 *     next run (the committed fill is picked up by the re-fold).
 */

import { getServiceRoleClient } from './supabase-server';
import {
  buildFillRow,
  buildPnlRow,
  buildPositionRow,
  fillFromRow,
  positionFromRow,
  type FillSelectRow,
} from './cockpit-rows-business-logic';
import type { PnlInsertRow } from './cockpit-rows-business-logic';
import { applyFills } from '@/lib/trading/pnl-business-logic';
import type { CanonicalFill } from '@/types/fill';
import type { Position } from '@/types/position';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Postgres unique_violation — a duplicate client_intent_id. */
const PG_UNIQUE_VIOLATION = '23505';

/** Columns needed to reconstruct a CanonicalFill from the ledger for folding. */
const FILL_LEDGER_COLUMNS =
  'client_intent_id, session_id, coin, side, px, sz, notional_usd, fee_usd, reduce_only, partial, source, hl_order_id, hl_raw, filled_at';

/**
 * Canonical coin normalization. The positions table is keyed on (session, coin)
 * with a case-sensitive unique constraint, and the realtime UI joins on coin, so
 * EVERY read/write path must agree on the same normalized form. Doing it in one
 * helper keeps the select filter, the upsert payload, and loadPosition aligned.
 */
function normalizeCoin(coin: string): string {
  return coin.trim().toUpperCase();
}

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
    .eq('coin', normalizeCoin(coin))
    .maybeSingle();
  if (error) throw new Error(`loadPosition failed: ${error.message}`);
  if (!data) return null;
  return positionFromRow(data as Parameters<typeof positionFromRow>[0]);
}

/**
 * Read just the recorded leverage for (session, coin), or null when none/unknown.
 * Leverage is position METADATA (it doesn't affect P&L) and lives only on the
 * positions row — loadPosition omits it. The adjust-leverage route needs the
 * current value to detect a no-op + decide raise-vs-lower. Read-only.
 */
export async function loadPositionLeverage(
  sessionId: string,
  coin: string,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<number | null> {
  const { data, error } = await client
    .from('positions')
    .select('leverage')
    .eq('session_id', sessionId)
    .eq('coin', normalizeCoin(coin))
    .maybeSingle();
  if (error) throw new Error(`loadPositionLeverage failed: ${error.message}`);
  const lev = (data as { leverage?: number | null } | null)?.leverage;
  return typeof lev === 'number' && Number.isFinite(lev) && lev > 0 ? lev : null;
}

/**
 * Persist a new leverage for (session, coin) WITHOUT touching size/side/entry —
 * leverage is metadata, so this is a targeted column update (never a re-fold).
 * Used by the adjust-leverage route AFTER the HL push succeeds (live) and by
 * reconciliation. Returns false on a write error (caller decides how to surface).
 */
export async function updatePositionLeverage(
  sessionId: string,
  coin: string,
  leverage: number,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<boolean> {
  const { error } = await client
    .from('positions')
    .update({ leverage })
    .eq('session_id', sessionId)
    .eq('coin', normalizeCoin(coin));
  return !error;
}

/**
 * List ALL open (non-flat) positions for a session. Read-only. Used by the
 * non-agent watch daemon to discover which coins to monitor — a fill creates a
 * positions row, so polling this is how the daemon auto-picks-up a position the
 * moment one opens. Returns [] (not throwing) when none exist.
 */
export async function loadOpenPositions(
  sessionId: string,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<Position[]> {
  const { data, error } = await client
    .from('positions')
    .select('coin, side, sz, avg_entry_px, realized_pnl_usd, fees_paid_usd')
    .eq('session_id', sessionId);
  if (error) throw new Error(`loadOpenPositions failed: ${error.message}`);
  if (!data) return [];
  return (data as Array<Parameters<typeof positionFromRow>[0]>)
    .map(positionFromRow)
    .filter((p) => p.side !== 'flat' && p.sz > 0);
}

/**
 * Append a pnl snapshot row carrying a MARK price + unrealized P&L. Used by the
 * non-agent watch daemon: a fill writes a pnl row with mark=null (unrealized not
 * yet known), but the watch loop marks the open position to market each tick and
 * persists the live unrealized P&L here, which the cockpit PositionPanel reads.
 */
export async function writePnlSnapshot(
  input: {
    sessionId: string;
    coin: string;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    feesPaidUsd: number;
    markPx: number | null;
  },
  client: SupabaseClient = getServiceRoleClient(),
): Promise<void> {
  const row: PnlInsertRow = {
    session_id: input.sessionId,
    coin: normalizeCoin(input.coin),
    realized_pnl_usd: input.realizedPnlUsd,
    unrealized_pnl_usd: input.unrealizedPnlUsd,
    fees_paid_usd: input.feesPaidUsd,
    mark_px: input.markPx,
  };
  const { error } = await client.from('pnl').insert(row);
  if (error) throw new Error(`writePnlSnapshot failed: ${error.message}`);
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
 * Recompute the position for (session, coin) by folding the WHOLE fills ledger,
 * then upsert the positions row + insert a pnl snapshot. Returns the new
 * position. Mode-agnostic — never inspects `fill.source`.
 *
 * Idempotent + crash-consistent by construction: it derives the position purely
 * from the immutable `fills` rows (the duplicate-guarded source of truth), so
 * calling it twice produces the same result and a partially-applied prior run
 * self-heals. See the file header + ADR-0001.
 */
export async function applyFillToPositionRows(
  fill: CanonicalFill,
  leverage?: number,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<Position> {
  const sessionId = fill.sessionId;
  const coin = normalizeCoin(fill.coin);

  // 1. Load the full fills ledger for this session+coin, oldest first, so the
  //    fold order matches execution order. This is the source of truth.
  const { data: fillRows, error: loadError } = await client
    .from('fills')
    .select(FILL_LEDGER_COLUMNS)
    .eq('session_id', sessionId)
    .eq('coin', coin)
    .order('filled_at', { ascending: true })
    // Deterministic tiebreak: two fills can share a microsecond-equal filled_at
    // under burst/retry; a stable secondary key keeps the fold order (and thus
    // realized P&L on flip-then-reduce sequences) reproducible.
    .order('id', { ascending: true });
  if (loadError) throw new Error(`applyFillToPositionRows load failed: ${loadError.message}`);

  // 2. Pure fold of the entire ledger — identical math regardless of source.
  const ledger = ((fillRows ?? []) as FillSelectRow[]).map(fillFromRow);
  const next = applyFills(coin, ledger);

  // 3. Upsert the positions row (unique on session_id+coin). Leverage is METADATA
  //    from the opening intent (not folded — ADR-0001); when known it's written so
  //    the UI derives ROE, when undefined the column is left out so a reduce-only
  //    re-fold preserves the entry leverage rather than nulling it.
  const positionRow = buildPositionRow(sessionId, next, new Date().toISOString(), leverage);
  const { error: upsertError } = await client
    .from('positions')
    .upsert(positionRow, { onConflict: 'session_id,coin' });
  if (upsertError) throw new Error(`applyFillToPositionRows upsert failed: ${upsertError.message}`);

  // 4. Append a pnl snapshot (realized + fees; unrealized needs a mark, left 0).
  const pnlRow = buildPnlRow(sessionId, next);
  const { error: pnlError } = await client.from('pnl').insert(pnlRow);
  if (pnlError) throw new Error(`applyFillToPositionRows pnl insert failed: ${pnlError.message}`);

  return next;
}
