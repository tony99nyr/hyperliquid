/**
 * rated_wallets I/O service — writes the weekly rankings to Supabase and reads
 * them back as a `RatedWalletsDataset` (the same shape as the committed JSON).
 *
 * WRITE (upsert) uses an ATOMIC GENERATION SWAP: insert every wallet row tagged
 * with a NEW generation, THEN flip `rated_wallets_meta.active_generation` (a
 * single-row update = the cutover), THEN delete old generations. A reader always
 * sees a whole generation, never a half-written re-rank.
 *
 * READ selects the active generation's rows (paginated — there are ~1600, over
 * PostgREST's default page size) ordered by composite, and assembles the dataset.
 * Returns null when Supabase is not configured or the table is empty, so callers
 * fall back to the committed JSON.
 *
 * Server-only (service-role for writes; reads also go through it here since the
 * cockpit page reads server-side and passes a slim projection to the client).
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import {
  buildRatedWalletRow,
  buildRatedMetaRow,
  ratedWalletFromRow,
  datasetFromMeta,
  type RatedWalletSelectRow,
  type RatedMetaSelectRow,
} from './rated-wallets-rows-business-logic';
import type { RatedWalletsDataset, RatedWallet } from './rated-wallets-service';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Insert batch size — keeps each request payload well under any limit. */
const INSERT_CHUNK = 500;
/** Read page size — PostgREST caps a single response, so we page through. */
const READ_PAGE = 1000;

export interface UpsertResult {
  generation: number;
  count: number;
}

/**
 * Upsert a whole dataset under a new generation, then atomically activate it and
 * prune older generations. `generation` defaults to `now` (epoch ms); callers
 * (the re-rank script) may pass one explicitly.
 */
export async function upsertRatedWalletsToDb(
  ds: RatedWalletsDataset,
  opts: { generation?: number; now?: number; client?: SupabaseClient } = {},
): Promise<UpsertResult> {
  const client = opts.client ?? getServiceRoleClient();
  const now = opts.now ?? Date.now();
  const generation = opts.generation ?? now;
  const nowIso = new Date(now).toISOString();
  const wallets = ds.wallets ?? [];

  // 1) Insert all wallet rows tagged with the NEW generation (not yet active).
  // The OLD generation stays active throughout (no partial read). On a partial
  // failure, best-effort remove the rows we did insert so a failed run leaves NO
  // orphans (otherwise they'd linger until the next successful run's prune).
  try {
    for (let i = 0; i < wallets.length; i += INSERT_CHUNK) {
      const rows = wallets.slice(i, i + INSERT_CHUNK).map((w) => buildRatedWalletRow(generation, w));
      const { error } = await client.from('rated_wallets').insert(rows);
      if (error) throw new Error(`upsertRatedWalletsToDb insert failed at row ${i}: ${error.message}`);
    }
  } catch (err) {
    try {
      await client.from('rated_wallets').delete().eq('generation', generation);
    } catch {
      /* best-effort cleanup — the next successful run's prune sweeps any remainder */
    }
    throw err;
  }

  // 2) Flip the active generation — the single-row ATOMIC cutover.
  const metaRow = buildRatedMetaRow(generation, ds, nowIso);
  const { error: metaErr } = await client
    .from('rated_wallets_meta')
    .upsert(metaRow, { onConflict: 'id' });
  if (metaErr) throw new Error(`upsertRatedWalletsToDb meta cutover failed: ${metaErr.message}`);

  // 3) Prune older generations (cleanup; readers already point at the new one).
  const { error: delErr } = await client
    .from('rated_wallets')
    .delete()
    .neq('generation', generation);
  if (delErr) {
    // Non-fatal: the new generation is live; stale rows are just disk. Surface it.
    throw new Error(`upsertRatedWalletsToDb prune failed (new gen IS live): ${delErr.message}`);
  }

  return { generation, count: wallets.length };
}

/**
 * Read the active generation's rankings as a `RatedWalletsDataset`. Returns null
 * when Supabase is unconfigured, there is no active generation, or it is empty —
 * the caller falls back to the committed JSON. Fail-soft: any error → null.
 */
export async function loadRatedWalletsFromDb(
  clientFactory: () => SupabaseClient = getServiceRoleClient,
): Promise<RatedWalletsDataset | null> {
  let client: SupabaseClient;
  try {
    client = clientFactory();
  } catch {
    return null; // Supabase not configured — fall back to JSON.
  }

  try {
    const { data: meta, error: metaErr } = await client
      .from('rated_wallets_meta')
      .select('active_generation, schema_version, description, philosophies, watch_window_edt, known_flags, count, generated_at')
      .eq('id', 1)
      .maybeSingle();
    if (metaErr) throw new Error(metaErr.message);

    const metaRow = meta as RatedMetaSelectRow | null;
    const gen = metaRow?.active_generation;
    if (!metaRow || gen === null || gen === undefined) return null; // no active re-rank yet

    // Page through the active generation's rows (ordered by composite).
    const wallets: RatedWallet[] = [];
    for (let from = 0; ; from += READ_PAGE) {
      const { data, error } = await client
        .from('rated_wallets')
        .select('address, short, display_name, composite, grades, metrics, flags, sources, trading_activity, leaderboard_top, anticipation_label, top_coins, worst_open')
        .eq('generation', gen)
        .order('composite', { ascending: false, nullsFirst: false })
        .range(from, from + READ_PAGE - 1);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as RatedWalletSelectRow[];
      wallets.push(...page.map(ratedWalletFromRow));
      if (page.length < READ_PAGE) break;
    }

    if (wallets.length === 0) return null; // empty generation — fall back to JSON
    return datasetFromMeta(metaRow, wallets);
  } catch {
    // Fail-soft: any read error → null so the caller uses the committed JSON.
    return null;
  }
}
