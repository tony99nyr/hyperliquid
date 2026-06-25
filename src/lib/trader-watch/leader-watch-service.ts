/**
 * Trade-watch service — thin I/O shell around the PURE `leader-diff-business-logic`.
 *
 * One cycle:
 *   1. Pick the top-N rated leaders (vendored rated-wallets dataset, via
 *      getTopTraders — no Supabase dependency for selection in Phase A).
 *   2. For each leader, fetch a FRESH `clearinghouseState` (HL public info API,
 *      cross-instance cached + fail-soft), map to slim position snapshots.
 *   3. Diff this cycle's snapshots against the previous cycle's (held in-memory
 *      per leader) → actions (open/add/reduce/close/flip).
 *   4. Persist: upsert leader_positions to exactly the live book (delete closed
 *      coins, upsert the rest), insert new leader_actions. Realtime pushes both
 *      to the cockpit.
 *
 * WATCH-ONLY — this module (and the whole `src/lib/trader-watch/` directory) MUST
 * NOT import the fill/execution path. It observes and reports; it never trades.
 * `tests/lib/trader-watch/no-trade-guarantee.test.ts` pins this statically.
 *
 * Resilience mirrors the cockpit watch daemon: a per-leader try/catch isolates
 * failures so one bad fetch/Supabase error doesn't abort the cycle or kill the
 * loop, plus a shared (per-IP-correct) exponential backoff on consecutive HL
 * failures. STALE GUARD: a fail-soft stale clearinghouse read is treated as a
 * failure and SKIPPED — never diffed — so an HL hiccup can't emit phantom
 * `close` actions for every position.
 */

import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchClearinghouseState, type HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getTopTraders } from '@/lib/hyperliquid/top-traders-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import {
  diffLeaderPositions,
  buildLeaderPositionRow,
  buildLeaderActionRow,
  type LeaderAction,
  type LeaderPositionSnapshot,
} from './leader-diff-business-logic';
import { resolveWatchSet, normalizeLeaderAddress } from './watch-set-business-logic';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Default number of top-rated leaders to watch. */
export const DEFAULT_TOP_N = 50;
/** Spacing between per-leader HL fetches (ms) — gentle pacing, not a hammer. */
const HL_REQUEST_SPACING_MS = 150;
/** Base + cap for exponential backoff after consecutive HL failures (ms). */
const HL_BACKOFF_BASE_MS = 500;
const HL_BACKOFF_MAX_MS = 8000;
/** Interruptible-sleep slice (ms) — small enough for prompt SIGINT. */
const SLEEP_SLICE_MS = 200;

export interface LeaderWatchConfig {
  /** How many top-rated leaders to watch. */
  topN: number;
}

export const DEFAULT_LEADER_WATCH_CONFIG: LeaderWatchConfig = { topN: DEFAULT_TOP_N };

/** In-memory previous-snapshot baseline, keyed by lowercased leader address. */
export type LeaderSnapshotStore = Map<string, LeaderPositionSnapshot[]>;

/** What one watched leader resolved to this cycle, for the caller's logging. */
export interface WatchedLeaderResult {
  leaderAddress: string;
  /** Open positions observed this cycle. */
  positions: number;
  /** Actions detected this cycle (empty on the first/baseline observation). */
  actions: LeaderAction[];
  /** True when this leader had no prior baseline (first observation = silent). */
  baselined: boolean;
}

/** The outcome of a full leader-watch cycle. */
export interface LeaderWatchCycleResult {
  /** Leaders selected to watch this cycle. */
  watched: number;
  /** Per-leader results that ticked OK. */
  results: WatchedLeaderResult[];
  /** Total actions written this cycle. */
  actionsEmitted: number;
  /** Per-leader failures (isolated — they do not abort the cycle). */
  failures: Array<{ leaderAddress: string; error: string }>;
}

// --- HL backoff (module-level: per-IP rate limits → one shared counter) ---

let consecutiveHlFailures = 0;

function currentBackoffMs(): number {
  if (consecutiveHlFailures <= 0) return 0;
  return Math.min(HL_BACKOFF_MAX_MS, HL_BACKOFF_BASE_MS * 2 ** (consecutiveHlFailures - 1));
}

/** Reset the HL backoff streak (test hook + called on a clean cycle). */
export function _resetHlBackoff(): void {
  consecutiveHlFailures = 0;
}

// Cold-start favorites seeding is attempted ONCE per process. After that, if the
// operator empties their favorites the watch is respected as "watch nothing" rather
// than silently re-seeding the top-12 every cycle (which would contradict the
// "favorites = the watch set" model). A daemon restart re-attempts the seed so a
// fresh process isn't left blind. Module-level so it survives across cycles.
let favoritesSeedAttempted = false;

/** Reset the once-per-process favorites-seed latch (test hook). */
export function _resetFavoritesSeed(): void {
  favoritesSeedAttempted = false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function interruptibleSleep(ms: number, shouldStop?: () => boolean): Promise<void> {
  if (ms <= 0) return;
  if (!shouldStop) {
    await sleep(ms);
    return;
  }
  const deadline = Date.now() + ms;
  while (!shouldStop() && Date.now() < deadline) {
    await sleep(Math.min(SLEEP_SLICE_MS, deadline - Date.now()));
  }
}

/** Map an HL position to the slim diff snapshot. PURE-ish (no I/O). */
export function snapshotFromHlPosition(p: HlPosition): LeaderPositionSnapshot {
  return {
    coin: p.coin,
    side: p.side,
    szi: p.szi,
    size: p.size,
    entryPx: p.entryPx,
    positionValue: p.positionValue,
    unrealizedPnl: p.unrealizedPnl,
    returnOnEquity: p.returnOnEquity,
    leverage: p.leverage,
    leverageType: p.leverageType,
    liquidationPx: p.liquidationPx,
  };
}

/**
 * Reconcile leader_positions to exactly the live book for one leader: delete rows
 * for coins no longer held, then upsert the current ones. Keeping the table = the
 * live open positions makes the cockpit rail/Leader-vs-You read trivial.
 */
async function reconcileLeaderPositions(
  client: SupabaseClient,
  leaderAddress: string,
  snapshots: LeaderPositionSnapshot[],
  accountValueUsd: number | null,
  fetchedAtIso: string,
): Promise<void> {
  const liveCoins = snapshots.map((s) => s.coin.trim().toUpperCase());

  // Delete coins this leader no longer holds (closed since the last reconcile).
  // `not in ()` on an empty list is invalid, so when flat we delete ALL the
  // leader's rows; otherwise delete those outside the live set.
  let del = client.from('leader_positions').delete().eq('leader_address', leaderAddress);
  if (liveCoins.length > 0) {
    del = del.not('coin', 'in', `(${liveCoins.join(',')})`);
  }
  const { error: delErr } = await del;
  if (delErr) throw new Error(`reconcileLeaderPositions delete failed: ${delErr.message}`);

  if (snapshots.length === 0) return;

  const rows = snapshots.map((s) =>
    buildLeaderPositionRow(leaderAddress, s, accountValueUsd, fetchedAtIso),
  );
  const { error: upErr } = await client
    .from('leader_positions')
    .upsert(rows, { onConflict: 'leader_address,coin' });
  if (upErr) throw new Error(`reconcileLeaderPositions upsert failed: ${upErr.message}`);
}

/** Append detected actions to leader_actions (no-op when empty). */
async function writeLeaderActions(client: SupabaseClient, actions: LeaderAction[]): Promise<void> {
  if (actions.length === 0) return;
  const rows = actions.map(buildLeaderActionRow);
  const { error } = await client.from('leader_actions').insert(rows);
  if (error) throw new Error(`writeLeaderActions failed: ${error.message}`);
}

/** Default retention window for the append-only leader_actions log (days). */
export const LEADER_ACTIONS_RETENTION_DAYS = 7;

/**
 * Delete leader_actions older than the retention window. leader_actions is an
 * append-only event log — without this it grows unbounded (it had reached ~400k
 * rows). The cockpit only ever reads the recent feed (limit 50), so anything past
 * a few days is dead weight on storage + every snapshot poll. Called periodically
 * from the daemon loop (NOT every cycle) and clientFactory-injectable for tests.
 *
 * No `.select()` so the deleted rows are never returned (zero egress for the prune
 * itself). Returns nothing meaningful; the caller logs the timestamp it ran.
 */
export async function pruneLeaderActions(
  client: SupabaseClient,
  retentionDays: number = LEADER_ACTIONS_RETENTION_DAYS,
  now: number = Date.now(),
): Promise<void> {
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await client.from('leader_actions').delete().lt('detected_at', cutoff);
  if (error) throw new Error(`pruneLeaderActions failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Favorites-gated watch set (the copy-trading pivot cost win). The live watch
// shrinks from top-50 to the operator's favorited_traders ∪ leaders of active
// followed_positions, read from Supabase each cycle.
// ---------------------------------------------------------------------------

/** Starter watch-set size when favorites is empty — small (« 50) IS the cost cut;
 *  the operator then curates via the favorites UI. */
export const SEED_FAVORITES_N = 12;

/**
 * Seed `favorited_traders` from the top-composite rated set ONLY when it is empty,
 * so a fresh deploy/migration isn't watching nothing (cold start). One-shot — once
 * the operator has any favorite this no-ops. Returns the number seeded.
 */
export async function seedFavoritesIfEmpty(
  client: SupabaseClient,
  seedN: number = SEED_FAVORITES_N,
): Promise<number> {
  const { count } = await client.from('favorited_traders').select('*', { count: 'exact', head: true });
  if ((count ?? 0) > 0) return 0;
  const seed = getTopTraders(seedN).map((t) => ({
    leader_address: normalizeLeaderAddress(t.address),
    note: 'auto-seeded (top composite)',
  }));
  if (seed.length === 0) return 0;
  const { error } = await client.from('favorited_traders').upsert(seed, { onConflict: 'leader_address' });
  if (error) throw new Error(`seedFavoritesIfEmpty failed: ${error.message}`);
  return seed.length;
}

/** Resolve the live watch set from Supabase: favorites ∪ leaders of active follows. */
export async function loadWatchSet(client: SupabaseClient): Promise<string[]> {
  const [favRes, followRes] = await Promise.all([
    client.from('favorited_traders').select('leader_address'),
    client.from('followed_positions').select('leader_address').eq('status', 'active'),
  ]);
  if (favRes.error) throw new Error(`loadWatchSet favorites failed: ${favRes.error.message}`);
  if (followRes.error) throw new Error(`loadWatchSet follows failed: ${followRes.error.message}`);
  return resolveWatchSet({
    favorites: (favRes.data ?? []).map((r) => (r as { leader_address: string }).leader_address),
    followLeaders: (followRes.data ?? []).map((r) => (r as { leader_address: string }).leader_address),
  });
}

/**
 * Durably delete leader_positions rows for leaders NO LONGER in the watch set
 * (un-favorited / un-followed). The per-leader reconcile only deletes for leaders
 * it ticks, so without this an un-favorited leader's book would linger forever. A
 * no-op when there are no orphans; an EMPTY watch set deletes all leader rows.
 */
export async function pruneOrphanLeaderPositions(
  client: SupabaseClient,
  watchSet: string[],
): Promise<void> {
  let del = client.from('leader_positions').delete();
  del =
    watchSet.length > 0
      ? del.not('leader_address', 'in', `(${watchSet.join(',')})`)
      : del.not('leader_address', 'is', null); // delete-all needs an (always-true) filter
  const { error } = await del;
  if (error) throw new Error(`pruneOrphanLeaderPositions failed: ${error.message}`);
}

/**
 * Tick ONE leader: fetch clearinghouse, map snapshots, diff against the prior
 * baseline (if any), persist positions + actions, and update the in-memory
 * baseline. Throws on a hard error (stale read, Supabase write) so the caller
 * isolates it. The FIRST observation of a leader establishes a SILENT baseline
 * (positions written, no actions) so a fresh process / restart never spams the
 * feed with `open` actions for already-open positions.
 */
export async function runLeaderTick(
  client: SupabaseClient,
  leaderAddress: string,
  prior: LeaderSnapshotStore,
  now: number,
): Promise<WatchedLeaderResult> {
  const state = await fetchClearinghouseState(leaderAddress);
  if (state.stale) {
    // Fail-soft stale read — DO NOT diff (would emit phantom closes). Treat as a
    // failure so the backoff engages and the baseline is left untouched.
    throw new Error(`stale clearinghouse for ${leaderAddress}${state.error ? ` (${state.error})` : ''}`);
  }

  const snapshots = state.positions.map(snapshotFromHlPosition);
  const fetchedAtIso = new Date(now).toISOString();

  const hadBaseline = prior.has(leaderAddress);
  const actions = hadBaseline
    ? diffLeaderPositions(leaderAddress, prior.get(leaderAddress) ?? [], snapshots)
    : [];

  // Reconcile the live book ONLY when something actually changed (first baseline,
  // or a detected open/add/reduce/close/flip). An idle leader's book is unchanged,
  // so re-upserting it every cycle just churns `updated_at` and fires a needless
  // realtime UPDATE per row — the dominant source of Realtime-message + egress
  // blowout (50 leaders × every cycle). Skipping the no-op write cuts that to
  // only-on-change. (size/side/entry only move on an action; accountValue drift
  // is cosmetic for the rail and resyncs on the next real change.)
  if (!hadBaseline || actions.length > 0) {
    await reconcileLeaderPositions(client, leaderAddress, snapshots, state.accountValueUsd, fetchedAtIso);
  }
  await writeLeaderActions(client, actions);

  // Update the baseline only AFTER a successful persist, so a write failure
  // re-tries the same diff next cycle instead of silently swallowing it.
  prior.set(leaderAddress, snapshots);

  return {
    leaderAddress,
    positions: snapshots.length,
    actions,
    baselined: !hadBaseline,
  };
}

/**
 * Run a full leader-watch CYCLE across the top-N leaders, isolating per-leader
 * failures. Returns a structured summary the script logs. Selection is read from
 * the vendored rated-wallets dataset (getTopTraders); `clientFactory` and `now`
 * are injectable for tests.
 */
export async function runLeaderWatchCycle(
  prior: LeaderSnapshotStore,
  opts: {
    config?: LeaderWatchConfig;
    now?: number;
    shouldStop?: () => boolean;
    clientFactory?: () => SupabaseClient;
    /** Favorites-gated watch: select favorites ∪ active-follow leaders from Supabase
     *  (seed if empty) instead of the static top-N. The production daemon sets this;
     *  legacy/tests omit it and keep the getTopTraders path. */
    useFavorites?: boolean;
  } = {},
): Promise<LeaderWatchCycleResult> {
  const config = opts.config ?? DEFAULT_LEADER_WATCH_CONFIG;
  const now = opts.now ?? Date.now();
  const { shouldStop } = opts;
  const client = (opts.clientFactory ?? getServiceRoleClient)();

  // Per-cycle backoff: snapshot ONCE based on the prior cycle's failure streak
  // and sleep it before any work (interruptible for prompt SIGINT).
  const backoff = currentBackoffMs();
  if (backoff > 0) await interruptibleSleep(backoff, shouldStop);

  let leaders: string[];
  if (opts.useFavorites) {
    if (!favoritesSeedAttempted) {
      await seedFavoritesIfEmpty(client);
      favoritesSeedAttempted = true;
    }
    leaders = await loadWatchSet(client);
    // Prune the in-memory baseline for leaders no longer watched, so a re-favorite
    // re-baselines silently (no phantom diff against a stale snapshot).
    const watching = new Set(leaders);
    for (const addr of [...prior.keys()]) if (!watching.has(addr)) prior.delete(addr);
    // Durable orphan cleanup: drop leader_positions for leaders no longer watched.
    await pruneOrphanLeaderPositions(client, leaders);
  } else {
    leaders = getTopTraders(config.topN).map((t) => t.address);
  }

  const results: WatchedLeaderResult[] = [];
  const failures: LeaderWatchCycleResult['failures'] = [];
  let cycleHlFailures = 0;
  let first = true;

  for (const leaderAddress of leaders) {
    if (shouldStop?.()) break;
    if (!first) await interruptibleSleep(HL_REQUEST_SPACING_MS, shouldStop);
    first = false;

    try {
      results.push(await runLeaderTick(client, leaderAddress, prior, now));
    } catch (err) {
      cycleHlFailures++;
      failures.push({ leaderAddress, error: extractErrorMessage(err) });
    }
  }

  // Streak grows at most once per cycle; a clean cycle resets it.
  if (cycleHlFailures === 0) consecutiveHlFailures = 0;
  else consecutiveHlFailures++;

  const actionsEmitted = results.reduce((sum, r) => sum + r.actions.length, 0);
  return { watched: leaders.length, results, actionsEmitted, failures };
}
