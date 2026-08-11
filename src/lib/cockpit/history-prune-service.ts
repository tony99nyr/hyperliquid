/**
 * Retention pruning for the append-only cockpit HISTORY tables (I/O).
 *
 * pnl, health_snapshots and rubric_scores are written every daemon tick / rubric
 * scan and were never pruned — by Aug 2026 they had grown to ~250 MB combined
 * (393k / 344k / 106k rows) with every consumer reading only the recent tail:
 * the cockpit panels reduce to latest-per-coin, the Performance curve looks back
 * 30 days, and the scout reads the last 2 hours of rubric scans. Everything past
 * the windows below is dead weight on storage and on every unbounded read.
 *
 * Mirrors the existing pruneLeaderActions pattern (leader-watch-service): no
 * `.select()` so deleted rows are never returned (zero egress for the prune
 * itself), fail-soft at the CALLER (a prune error must never break monitoring),
 * clientFactory-injectable for tests. Called from the watch daemon loop roughly
 * once a day — NOT every cycle.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient } from './supabase-server';

/** pnl snapshots: the Performance equity curve reads 30d — keep double. */
export const PNL_RETENTION_DAYS = 60;
/** health_snapshots: panels read latest-per-coin; keep a month of history. */
export const HEALTH_RETENTION_DAYS = 30;
/** rubric_scores: the scout reads ~2h, the board reads the latest scan. */
export const RUBRIC_RETENTION_DAYS = 30;

/** Delete history rows older than each table's retention window. Throws on the
 * first hard error (callers treat the whole sweep as best-effort). */
export async function pruneCockpitHistory(
  client: SupabaseClient = getServiceRoleClient(),
  now: number = Date.now(),
): Promise<void> {
  const cutoff = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  const { error: pnlErr } = await client.from('pnl').delete().lt('created_at', cutoff(PNL_RETENTION_DAYS));
  if (pnlErr) throw new Error(`pruneCockpitHistory pnl failed: ${pnlErr.message}`);

  const { error: healthErr } = await client
    .from('health_snapshots')
    .delete()
    .lt('created_at', cutoff(HEALTH_RETENTION_DAYS));
  if (healthErr) throw new Error(`pruneCockpitHistory health_snapshots failed: ${healthErr.message}`);

  const { error: rubricErr } = await client
    .from('rubric_scores')
    .delete()
    .lt('computed_at', cutoff(RUBRIC_RETENTION_DAYS));
  if (rubricErr) throw new Error(`pruneCockpitHistory rubric_scores failed: ${rubricErr.message}`);
}
