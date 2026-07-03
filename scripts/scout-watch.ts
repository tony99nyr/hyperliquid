/**
 * pnpm scout:watch — the FREE deterministic trigger daemon (thin I/O entrypoint).
 *
 * The cheap, always-on layer of the autonomous paper scout. Every ~60s it reads
 * the latest deterministic signals (rubric_scores + fresh marks + open paper
 * positions) and, when something MATERIAL changes, appends a trigger to a JSONL
 * file the (cheap-model) scout session watches with a Monitor. It costs ZERO
 * model tokens — a model is only invoked downstream when a trigger fires (the
 * inverted loop that keeps Opus/Sonnet usage rationed).
 *
 * NEVER trades. Mirrors the watch daemon's resilience: SIGINT-safe, fail-soft
 * per cycle, heartbeat each tick. Trigger state PERSISTS to disk and reloads on
 * boot, so a restart resumes from the latest baseline instead of re-baselining
 * blind (which would miss a breakout during the first post-restart cycle).
 *
 * Usage:
 *   pnpm scout:watch                 # loop every ~60s
 *   pnpm scout:watch --interval 30   # loop every 30s
 *   pnpm scout:watch --once          # single cycle (verification)
 */

import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import {
  runScoutWatchCycle,
  scoutTriggerFilePath,
  loadScoutState,
  saveScoutState,
  writeScoutHeartbeat,
} from '@/lib/scout/scout-watch-service';
import { type ScoutState } from '@/lib/scout/scout-trigger-business-logic';

const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 15;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function preflight(): Promise<void> {
  header('scout-watch — preflight');
  try {
    getServiceRoleClient();
    line('✓ Supabase service-role client configured.');
  } catch (err) {
    throw new Error(
      `Supabase is NOT configured — scout-watch cannot read rubric/positions. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const probe = await fetchCandles('BTC', '15m', Date.now() - 60 * 60 * 1000, Date.now());
  if (probe.stale || probe.candles.length === 0) {
    throw new Error(`Hyperliquid unreachable (probe ${probe.stale ? 'stale' : 'empty'}) — refusing to start.`);
  }
  line('✓ Hyperliquid reachable.');
  line(`Trigger sink: supabase scout_triggers (primary) → JSONL fallback ${scoutTriggerFilePath()}`);
}

async function oneCycle(state: ScoutState): Promise<ScoutState> {
  const ts = new Date().toISOString();
  try {
    const { triggers, state: next, degraded, degradedReason, sink } = await runScoutWatchCycle(state);
    saveScoutState(next); // persist so a restart resumes from the latest baseline
    if (degraded) {
      line(`[${ts}] ⏸ STAND DOWN — feed degraded: ${degradedReason} (no triggers emitted)`);
    } else if (triggers.length === 0) {
      line(`[${ts}] no triggers`);
    } else {
      for (const t of triggers) line(`[${ts}] ⚡ ${t.urgency.toUpperCase()} ${t.kind} — ${t.detail}`);
    }
    // Sink adapter matters operationally: 'jsonl' = Supabase unreachable, these triggers
    // are INVISIBLE to a table-reading consumer on another box; 'none' = both sinks failed.
    const sinkNote = triggers.length > 0 && sink !== 'supabase' ? ` ⚠ sink=${sink}` : '';
    if (sinkNote) line(`[${ts}]${sinkNote} — triggers not in the table; a remote consumer cannot see them`);
    await writeScoutHeartbeat(
      degraded ? 'degraded' : sink === 'none' && triggers.length > 0 ? 'sink-failed' : 'ok',
      degraded ? (degradedReason ?? 'degraded') : `${triggers.length} trigger(s)${sinkNote}`,
    );
    return next;
  } catch (err) {
    line(`[${ts}] WARN cycle error (continuing): ${err instanceof Error ? err.message : String(err)}`);
    return state;
  }
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const once = args['once'] === true || args['once'] === 'true';
  const interval = Math.max(MIN_INTERVAL_SECONDS, optionalNumber(args, 'interval', DEFAULT_INTERVAL_SECONDS));

  await preflight();

  // Resume from persisted baseline (survives restart → no blind first cycle that
  // could miss a breakout). Falls back to empty if absent/corrupt.
  let state = loadScoutState();

  if (once) {
    header('scout-watch — single cycle (--once)');
    line('NEVER trades. Running one trigger cycle…');
    await oneCycle(state);
    line('Done (--once).');
    return;
  }

  header(`scout-watch — loop every ${interval}s (Ctrl-C to stop)`);
  line('NEVER trades. Watching for material triggers…');
  let stopping = false;
  const requestStop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    line(`\nReceived ${sig} — finishing the in-flight cycle, then exiting…`);
  };
  process.on('SIGINT', () => requestStop('SIGINT'));
  process.on('SIGTERM', () => requestStop('SIGTERM'));

  const intervalMs = interval * 1000;
  while (!stopping) {
    const cycleStart = Date.now();
    state = await oneCycle(state);
    if (stopping) break;
    const wakeAt = cycleStart + intervalMs;
    while (!stopping && Date.now() < wakeAt) await sleep(Math.min(250, wakeAt - Date.now()));
  }
  line('scout-watch stopped cleanly.');
});
