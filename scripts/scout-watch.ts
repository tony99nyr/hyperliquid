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
 * per cycle, heartbeat each tick. In-process trigger state means a restart
 * re-baselines (the first cycle after restart emits nothing — intentional).
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
} from '@/lib/scout/scout-watch-service';
import { emptyScoutState, type ScoutState } from '@/lib/scout/scout-trigger-business-logic';

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
  line(`Trigger sink: ${scoutTriggerFilePath()}`);
}

async function oneCycle(state: ScoutState): Promise<ScoutState> {
  const ts = new Date().toISOString();
  try {
    const { triggers, state: next } = await runScoutWatchCycle(state);
    if (triggers.length === 0) {
      line(`[${ts}] no triggers`);
    } else {
      for (const t of triggers) line(`[${ts}] ⚡ ${t.urgency.toUpperCase()} ${t.kind} — ${t.detail}`);
    }
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

  let state = emptyScoutState();

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
