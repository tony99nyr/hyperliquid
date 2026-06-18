/**
 * PURE mappers between the `RatedWallet` / `RatedWalletsDataset` domain shape and
 * the snake_case `rated_wallets` / `rated_wallets_meta` Supabase rows.
 *
 * The weekly re-rank pipeline produces a `RatedWalletsDataset` (the same shape as
 * the committed rated-wallets.json); these functions turn it into DB rows for the
 * upsert, and back into the dataset for the readers — with zero I/O so they are
 * unit-testable with fixtures.
 */

import type {
  RatedWallet,
  RatedWalletsDataset,
  RatedWalletMetrics,
  TradingActivity,
  PhilosophyGrade,
  WatchWindowEdt,
} from './rated-wallets-service';

// ---------------------------------------------------------------------------
// rated_wallets rows
// ---------------------------------------------------------------------------

export interface RatedWalletInsertRow {
  generation: number;
  address: string;
  short: string;
  display_name: string | null;
  composite: number | null;
  grades: Record<string, PhilosophyGrade>;
  metrics: RatedWalletMetrics;
  flags: string[];
  sources: string[];
  trading_activity: TradingActivity | null;
  leaderboard_top: boolean;
  anticipation_label: string | null;
  top_coins: string[];
  worst_open: RatedWallet['worstOpen'] | null;
}

/** Map one domain wallet → an insert row tagged with the run `generation`. PURE. */
export function buildRatedWalletRow(generation: number, w: RatedWallet): RatedWalletInsertRow {
  return {
    generation,
    address: w.address,
    short: w.short,
    display_name: w.displayName ?? null,
    composite: w.composite,
    grades: w.grades ?? {},
    metrics: w.metrics ?? {},
    flags: w.flags ?? [],
    sources: w.sources ?? [],
    trading_activity: w.tradingActivity ?? null,
    leaderboard_top: w.leaderboardTop ?? false,
    anticipation_label: w.anticipationLabel ?? null,
    top_coins: w.topCoins ?? [],
    worst_open: w.worstOpen ?? null,
  };
}

/** A `rated_wallets` row as read back (jsonb columns surface as objects). */
export interface RatedWalletSelectRow {
  address: string;
  short: string;
  display_name: string | null;
  composite: number | string | null;
  grades: Record<string, PhilosophyGrade> | null;
  metrics: RatedWalletMetrics | null;
  flags: string[] | null;
  sources: string[] | null;
  trading_activity: TradingActivity | null;
  leaderboard_top: boolean | null;
  anticipation_label: string | null;
  top_coins: string[] | null;
  worst_open: RatedWallet['worstOpen'] | null;
}

function toNumOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Reconstruct a domain `RatedWallet` from a DB row. The inverse of build. PURE. */
export function ratedWalletFromRow(row: RatedWalletSelectRow): RatedWallet {
  return {
    address: row.address,
    short: row.short,
    displayName: row.display_name,
    composite: toNumOrNull(row.composite),
    grades: row.grades ?? {},
    metrics: row.metrics ?? {},
    flags: row.flags ?? [],
    sources: row.sources ?? [],
    tradingActivity: row.trading_activity ?? null,
    leaderboardTop: row.leaderboard_top ?? false,
    anticipationLabel: row.anticipation_label ?? undefined,
    topCoins: row.top_coins ?? [],
    worstOpen: row.worst_open ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// rated_wallets_meta row (singleton)
// ---------------------------------------------------------------------------

export interface RatedMetaUpsertRow {
  id: 1;
  active_generation: number;
  schema_version: number;
  description: string | null;
  philosophies: string[];
  watch_window_edt: WatchWindowEdt;
  known_flags: string[];
  count: number;
  generated_at: string;
  updated_at: string;
}

/**
 * Build the singleton meta upsert row for a run. `generation` is the run tag the
 * wallet rows carry; flipping `active_generation` to it is the atomic cutover.
 * `updatedAtIso` is injected (no clock here). PURE.
 */
export function buildRatedMetaRow(
  generation: number,
  ds: RatedWalletsDataset,
  updatedAtIso: string,
): RatedMetaUpsertRow {
  return {
    id: 1,
    active_generation: generation,
    schema_version: ds.schemaVersion ?? 1,
    description: ds.description ?? null,
    philosophies: ds.philosophies ?? [],
    watch_window_edt: ds.watchWindowEdt ?? { startHour: 8, endHour: 22 },
    known_flags: ds.knownFlags ?? [],
    count: typeof ds.count === 'number' ? ds.count : ds.wallets.length,
    generated_at: ds.generatedAt ?? updatedAtIso,
    updated_at: updatedAtIso,
  };
}

export interface RatedMetaSelectRow {
  active_generation: number | null;
  schema_version: number | null;
  description: string | null;
  philosophies: string[] | null;
  watch_window_edt: WatchWindowEdt | null;
  known_flags: string[] | null;
  count: number | null;
  generated_at: string | null;
}

/**
 * Assemble a `RatedWalletsDataset` from the meta row + the active generation's
 * wallets. The inverse of the build path; used by the DB reader. PURE.
 */
export function datasetFromMeta(
  meta: RatedMetaSelectRow,
  wallets: RatedWallet[],
): RatedWalletsDataset {
  return {
    schemaVersion: meta.schema_version ?? 1,
    generatedAt: meta.generated_at ?? '',
    description: meta.description ?? '',
    philosophies: meta.philosophies ?? [],
    watchWindowEdt: meta.watch_window_edt ?? { startHour: 8, endHour: 22 },
    knownFlags: meta.known_flags ?? [],
    count: typeof meta.count === 'number' ? meta.count : wallets.length,
    wallets,
  };
}
