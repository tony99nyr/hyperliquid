/**
 * pnpm trader-watch — the TRADE-WATCH SERVICE (thin I/O entrypoint).
 *
 * An always-on, NON-AGENT poller that runs on the NAS (alongside the relayer),
 * OUTSIDE any Claude session. Each cycle it fetches the top-N rated leaders'
 * Hyperliquid positions, DIFFS them against the previous cycle, and writes the
 * current `leader_positions` + new `leader_actions` to Supabase so the cockpit +
 * skills read Supabase instead of hammering HL (which also structurally cuts the
 * Vercel 429s — HL reads centralize on this one NAS IP).
 *
 * WATCH-ONLY. It NEVER places a trade. The fill/execution path is never imported
 * here or in `src/lib/trader-watch/**` — pinned by
 * tests/lib/trader-watch/no-trade-guarantee.test.ts.
 *
 * RESTART-SAFE: the previous-snapshot baseline is in-memory, so a fresh process
 * establishes a SILENT baseline on each leader's first observation (positions
 * written, no actions) — it never spams the feed with `open` actions for
 * already-open positions. leader_positions is reconciled to the live book every
 * cycle, so the rail is correct immediately after a restart.
 *
 * Usage:
 *   pnpm trader-watch                  # loop forever, ~30s interval, top 30
 *   pnpm trader-watch --interval 15    # loop every 15s
 *   pnpm trader-watch --top 50         # watch the top 50 leaders
 *   pnpm trader-watch --once           # run a single cycle and exit (verification)
 *
 * Resilience: one failing leader is logged and the cycle continues (failures are
 * isolated per leader). SIGINT/SIGTERM finish the in-flight cycle, then exit.
 */

import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import {
  runLeaderWatchCycle,
  pruneLeaderActions,
  LEADER_ACTIONS_RETENTION_DAYS,
  DEFAULT_TOP_N,
  type LeaderSnapshotStore,
} from '@/lib/trader-watch/leader-watch-service';
import { formatLeaderAction } from '@/lib/trader-watch/leader-diff-business-logic';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getTopTraders } from '@/lib/hyperliquid/top-traders-service';

/** Default poll interval (seconds) — 60s balances freshness vs HL + Supabase load.
 *  (Was 30s; with diff-only writes the rail rarely changes between cycles, so the
 *  slower cadence cuts daemon load without meaningfully staling the leader feed.) */
const DEFAULT_INTERVAL_SECONDS = 60;
/** Floor so a fat-fingered --interval 0 cannot hammer HL/Supabase. */
const MIN_INTERVAL_SECONDS = 5;
/** Consecutive total-failure cycles before a LOUD escalation log. */
const ESCALATE_AFTER_FAILED_CYCLES = 3;
/** How often to prune the append-only leader_actions log (ms). Hourly keeps the
 *  table bounded to its retention window without churning the loop. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fire-and-forget retention prune; fail-soft (a transient Supabase error must
 *  never kill the watch loop). Logs what it did. */
async function pruneRetentionSoft(): Promise<void> {
  const ts = new Date().toISOString();
  try {
    await pruneLeaderActions(getServiceRoleClient());
    line(`[${ts}] pruned leader_actions older than ${LEADER_ACTIONS_RETENTION_DAYS}d.`);
  } catch (err) {
    line(`[${ts}] WARN leader_actions prune failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * STARTUP HARD-CHECK: fail LOUD + non-zero if the service can't actually do its
 * job — Supabase must be configured, the rated-wallets dataset must yield
 * leaders, and a probe HL clearinghouse fetch must return live (non-stale) data.
 * Per-cycle transient errors stay fail-soft (they must not kill the loop); this
 * just proves the wiring before we begin.
 */
async function preflight(topN: number): Promise<void> {
  header('trade-watch service — preflight');

  try {
    getServiceRoleClient();
    line('✓ Supabase service-role client configured.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Supabase is NOT configured — the service cannot write leader_positions/` +
        `leader_actions and would watch NOTHING silently. ${msg}`,
    );
  }

  const leaders = getTopTraders(topN);
  if (leaders.length === 0) {
    throw new Error(
      'No rated leaders found — data/backups/wallet-rating/rated-wallets.json is ' +
        'missing or empty. Cannot select wallets to watch.',
    );
  }
  line(`✓ ${leaders.length} rated leader(s) selected (top ${topN}).`);

  const probe = await fetchClearinghouseState(leaders[0].address);
  if (probe.stale) {
    throw new Error(
      `Hyperliquid is unreachable (probe clearinghouse for ${leaders[0].short} ` +
        `stale${probe.error ? `: ${probe.error}` : ''}) — refusing to start a watcher ` +
        `that can't read positions.`,
    );
  }
  line(`✓ Hyperliquid reachable (probe ${leaders[0].short}: ${probe.positions.length} open position(s)).`);
}

/** Outcome of one cycle for the loop's heartbeat + failure-escalation tracking. */
interface CycleOutcome {
  watched: number;
  actionsEmitted: number;
  ok: boolean;
}

async function runOneCycle(
  prior: LeaderSnapshotStore,
  topN: number,
  shouldStop?: () => boolean,
): Promise<CycleOutcome> {
  const ts = new Date().toISOString();
  try {
    const result = await runLeaderWatchCycle(prior, {
      config: { topN },
      shouldStop,
      // Copy-trading pivot: watch the operator's favorites ∪ active-follow leaders
      // (seeded from top-composite on first run), not the static top-N. The cost cut.
      useFavorites: true,
    });

    const shortOf = new Map(getTopTraders(topN).map((t) => [t.address, t.short]));
    for (const r of result.results) {
      for (const a of r.actions) {
        line(`[${ts}] ★ ${formatLeaderAction(a, shortOf.get(a.leaderAddress) ?? a.leaderAddress)}`);
      }
    }
    const baselined = result.results.filter((r) => r.baselined).length;
    line(
      `[${ts}] watched ${result.watched} leader(s), ${result.actionsEmitted} action(s)` +
        (baselined > 0 ? `, ${baselined} baselined` : '') +
        (result.failures.length > 0 ? `, ${result.failures.length} failed` : ''),
    );
    for (const f of result.failures) {
      line(`[${ts}] WARN leader failed: ${f.leaderAddress.slice(0, 10)}… — ${f.error}`);
    }

    // A cycle is a TOTAL failure only when it attempted leaders and every attempt
    // failed; a cycle with at least one OK tick (or zero leaders) is healthy.
    const attempted = result.results.length + result.failures.length;
    const ok = attempted === 0 || result.results.length > 0;
    return { watched: result.watched, actionsEmitted: result.actionsEmitted, ok };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    line(`[${ts}] WARN cycle error (continuing): ${msg}`);
    return { watched: 0, actionsEmitted: 0, ok: false };
  }
}

function fmtAge(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const once = args['once'] === true || args['once'] === 'true';
  const interval = Math.max(
    MIN_INTERVAL_SECONDS,
    optionalNumber(args, 'interval', DEFAULT_INTERVAL_SECONDS),
  );
  // Standing top-N: --top flag → TRADER_WATCH_TOP_N env → built-in default (50).
  // The env override lets the NAS retune the watch breadth via .env.local without
  // a code change/pull.
  const envTop = Number(process.env.TRADER_WATCH_TOP_N);
  const baseTop = Number.isFinite(envTop) && envTop > 0 ? Math.floor(envTop) : DEFAULT_TOP_N;
  const topN = Math.max(1, optionalNumber(args, 'top', baseTop));

  // Previous-snapshot baseline per leader lives in-process (see file header).
  const prior: LeaderSnapshotStore = new Map();

  await preflight(topN);

  if (once) {
    header('trade-watch service — single cycle (--once)');
    line('WATCH-ONLY: this never places a trade. Running one cycle…');
    await runOneCycle(prior, topN);
    await pruneRetentionSoft();
    line('Done (--once).');
    return;
  }

  header(`trade-watch service — loop every ${interval}s, top ${topN} (Ctrl-C to stop)`);
  line('WATCH-ONLY: this never places a trade. Polling leaders…');

  let stopping = false;
  const requestStop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    line(`\nReceived ${sig} — finishing the in-flight cycle, then exiting…`);
  };
  process.on('SIGINT', () => requestStop('SIGINT'));
  process.on('SIGTERM', () => requestStop('SIGTERM'));

  let lastSuccessfulCycleAt = Date.now();
  let consecutiveFailedCycles = 0;
  const intervalMs = interval * 1000;

  // Prune once at startup (cleans up whatever accumulated while the daemon was
  // down), then hourly thereafter.
  await pruneRetentionSoft();
  let lastPruneAt = Date.now();

  while (!stopping) {
    const cycleStart = Date.now();
    const outcome = await runOneCycle(prior, topN, () => stopping);

    if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
      await pruneRetentionSoft();
      lastPruneAt = Date.now();
    }

    if (outcome.ok) {
      lastSuccessfulCycleAt = Date.now();
      consecutiveFailedCycles = 0;
    } else {
      consecutiveFailedCycles++;
    }

    const ts = new Date().toISOString();
    line(
      `[${ts}] trade-watch alive — ${outcome.watched} leader(s), ` +
        `${outcome.actionsEmitted} action(s) this cycle, last ok ` +
        `${fmtAge(Date.now() - lastSuccessfulCycleAt)} ago` +
        (consecutiveFailedCycles > 0 ? ` (⚠ ${consecutiveFailedCycles} failed cycle(s))` : ''),
    );

    if (consecutiveFailedCycles >= ESCALATE_AFTER_FAILED_CYCLES) {
      console.error(
        `\n[${ts}] ‼ TRADE-WATCH DEGRADED — ${consecutiveFailedCycles} consecutive ` +
          `failed cycles, no successful cycle in ${fmtAge(Date.now() - lastSuccessfulCycleAt)}. ` +
          `Check HL/Supabase connectivity.`,
      );
    }

    const elapsed = Date.now() - cycleStart;
    if (elapsed > intervalMs) {
      line(
        `[${ts}] WARN cycle overrun: took ${fmtAge(elapsed)} > interval ${interval}s ` +
          `(effective cadence is stretching).`,
      );
    }

    if (stopping) break;
    const wakeAt = cycleStart + intervalMs;
    while (!stopping && Date.now() < wakeAt) {
      await sleep(Math.min(250, wakeAt - Date.now()));
    }
  }

  line('trade-watch service stopped cleanly.');
});
