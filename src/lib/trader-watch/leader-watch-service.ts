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

  // Always reconcile the live book first (so the rail is fresh even on baseline),
  // then append any actions.
  await reconcileLeaderPositions(
    client,
    leaderAddress,
    snapshots,
    state.accountValueUsd,
    fetchedAtIso,
  );
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

  const leaders = getTopTraders(config.topN).map((t) => t.address);

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
