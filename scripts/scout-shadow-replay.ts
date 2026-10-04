/**
 * pnpm scout:shadow-replay — the blind-day sample-loss audit (retro 2026-10-03).
 *
 * Replays the two mechanical candle lanes (htf-trend daily Donchian, compression
 * 4h squeeze) over a review window with the lanes' own frozen rules, groups the
 * would-have-fired bars into entry episodes, and diffs them against the actual
 * hypotheses ledger. A missed episode = an entry opportunity the scout never
 * recorded (daemon down, consumer down, or sink failure) — the number the n=20
 * graduation checkpoint must correct for.
 *
 * READ-ONLY: candles from HL, one SELECT on hypotheses. NEVER trades, writes
 * nothing, and imports nothing from the fill/execution path.
 *
 *   pnpm scout:shadow-replay                       # 60d, ETH/BTC/HYPE/SOL, both lanes
 *   pnpm scout:shadow-replay --days 30 --coins ETH,BTC --lanes htf-trend --json
 */

import { run } from './_skill-runtime';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import {
  replayHtfTrend,
  replayCompression,
  groupEpisodes,
  diffShadowAgainstActual,
  sampleLossFrac,
  LANE_BAR_MS,
  type ShadowLane,
  type ShadowBar,
  type ShadowEvent,
  type ActualEntry,
} from '@/lib/scout/shadow-replay-business-logic';

const DAY_MS = 86_400_000;
/** Pre-window candle lookback per lane (the scan services' own requirements). */
const HTF_LOOKBACK_MS = 70 * DAY_MS;
const COMPRESSION_LOOKBACK_MS = 36 * DAY_MS;

/** Mirrors the daemon's rubric scan universe (the NAS rubric covers these four). */
const DEFAULT_COINS = ['ETH', 'BTC', 'HYPE', 'SOL'];
const ALL_LANES: ShadowLane[] = ['htf-trend', 'compression-straddle'];

/** Each lane's pre-registration date (docs/scout/PREREGISTRATION_*.md). A signal
 *  before the lane EXISTED is not sample loss — the window clamps to this. */
const LANE_REGISTERED_AT_MS: Record<ShadowLane, number> = {
  'htf-trend': Date.UTC(2026, 7, 1), // 2026-08-01
  'compression-straddle': Date.UTC(2026, 7, 13), // 2026-08-13
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const fmtDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const fmtBar = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

async function main(): Promise<void> {
  const daysRaw = arg('days');
  const days = daysRaw == null ? 60 : Number(daysRaw);
  if (!Number.isFinite(days) || days < 1) {
    console.error(`--days must be a positive number (got '${daysRaw}')`);
    process.exitCode = 1;
    return;
  }
  const coins = [
    ...new Set(
      (arg('coins') ?? DEFAULT_COINS.join(','))
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (coins.length === 0) {
    console.error('No valid coins — pass --coins as a comma-separated list, e.g. --coins ETH,BTC');
    process.exitCode = 1;
    return;
  }
  const laneArgs = [...new Set((arg('lanes') ?? ALL_LANES.join(',')).split(',').map((l) => l.trim()).filter(Boolean))];
  const lanes = laneArgs.filter((l): l is ShadowLane => (ALL_LANES as string[]).includes(l));
  const dropped = laneArgs.filter((l) => !(ALL_LANES as string[]).includes(l));
  if (dropped.length > 0) console.error(`⚠ unknown lane(s) ignored: ${dropped.join(', ')} (valid: ${ALL_LANES.join(', ')})`);
  if (lanes.length === 0) {
    console.error(`No valid lanes — pass --lanes with any of: ${ALL_LANES.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const json = process.argv.includes('--json');
  const now = Date.now();
  const windowStartMs = now - days * DAY_MS;
  // Per-lane replay start: the window, clamped to the lane's registration date.
  const laneStartMs = (lane: ShadowLane): number => Math.max(windowStartMs, LANE_REGISTERED_AT_MS[lane]);

  const events: ShadowEvent[] = [];
  const coverage: string[] = [];
  for (const coin of coins) {
    if (lanes.includes('htf-trend')) {
      const res = await fetchCandles(coin, '1d', laneStartMs('htf-trend') - HTF_LOOKBACK_MS, now);
      const completed = res.candles.slice(0, -1); // completed bars only, like the live scan
      if (res.stale || completed.length === 0) {
        coverage.push(`${coin} 1d: SKIPPED (${res.stale ? 'stale' : 'empty'}) — htf-trend not replayed`);
      } else {
        const bars: ShadowBar[] = completed.map((c) => ({ timeMs: c.timestamp, highPx: c.high, lowPx: c.low, closePx: c.close }));
        events.push(...replayHtfTrend(bars, coin, laneStartMs('htf-trend')));
      }
    }
    if (lanes.includes('compression-straddle')) {
      const res = await fetchCandles(coin, '4h', laneStartMs('compression-straddle') - COMPRESSION_LOOKBACK_MS, now);
      const completed = res.candles.slice(0, -1);
      if (res.stale || completed.length === 0) {
        coverage.push(`${coin} 4h: SKIPPED (${res.stale ? 'stale' : 'empty'}) — compression not replayed`);
      } else {
        const bars: ShadowBar[] = completed.map((c) => ({ timeMs: c.timestamp, highPx: c.high, lowPx: c.low, closePx: c.close }));
        events.push(...replayCompression(bars, coin, laneStartMs('compression-straddle')));
      }
    }
  }

  const episodes = groupEpisodes(events);

  // The actual ledger over the REPLAYED range (a little slack before the start so an
  // entry from an episode straddling the boundary still matches; clamped like the
  // replay, or pre-registration rows would pollute `unexplainedActual`).
  const since = new Date(Math.min(...lanes.map(laneStartMs)) - 2 * DAY_MS).toISOString();
  const { data, error } = await getServiceRoleClient()
    .from('hypotheses')
    .select('lane, coin, created_at')
    .in('lane', lanes)
    .gte('created_at', since);
  if (error) throw new Error(`hypotheses read failed: ${error.message}`);
  const actual: ActualEntry[] = (data ?? [])
    .filter((r): r is { lane: string; coin: string; created_at: string } => typeof r.lane === 'string' && typeof r.coin === 'string')
    .map((r) => ({ lane: r.lane, coin: r.coin, createdAtMs: Date.parse(r.created_at) }));

  const diff = diffShadowAgainstActual(episodes, actual);

  if (json) {
    console.log(JSON.stringify({ days, coins, lanes, coverage, episodes, diff, sampleLoss: Object.fromEntries(lanes.map((l) => [l, sampleLossFrac(diff, l)])) }, null, 2));
    return;
  }

  console.log(`=== scout shadow-replay — ${days}d window (${fmtDay(windowStartMs)} → ${fmtDay(now)}), coins [${coins.join(', ')}] ===`);
  console.log('READ-ONLY audit: what the frozen lane rules WOULD have fired vs what the ledger recorded. Never trades.');
  for (const c of coverage) console.log(`  ⚠ ${c}`);
  for (const lane of lanes) {
    const eps = episodes.filter((e) => e.lane === lane);
    const missed = diff.missed.filter((e) => e.lane === lane);
    const matched = diff.matched.filter((m) => m.episode.lane === lane);
    console.log(`\n--- ${lane} (from ${fmtDay(laneStartMs(lane))}, its registration-clamped window): ${eps.length} episode(s), ${matched.length} matched, ${missed.length} MISSED (sample loss ${(sampleLossFrac(diff, lane) * 100).toFixed(0)}%) ---`);
    for (const ep of eps) {
      const m = matched.find((x) => x.episode === ep);
      const span = ep.firstBarMs === ep.lastBarMs ? fmtBar(ep.firstBarMs) : `${fmtBar(ep.firstBarMs)} → ${fmtBar(ep.lastBarMs)}`;
      console.log(
        `  ${m ? '✓' : '✗ MISSED'} ${ep.coin} ${ep.side} @ ${ep.entryPx} (stop ${ep.stopPx}) · ${span} · ${ep.events} bar(s)` +
          (m ? ` · ledger ${fmtBar(m.actualAtMs)}` : ''),
      );
    }
  }
  if (diff.unexplainedActual.length > 0) {
    console.log(`\n⚠ ${diff.unexplainedActual.length} ledger row(s) no replayed episode explains (replay-fidelity flag, not sample loss):`);
    for (const a of diff.unexplainedActual) console.log(`  ${a.lane} ${a.coin} @ ${fmtBar(a.createdAtMs)}`);
  }
  const barNote = lanes.map((l) => `${l}=${LANE_BAR_MS[l] / 3_600_000}h bars`).join(', ');
  console.log(`\nMISSED = the lane's rule fired but nothing reached the ledger (daemon/consumer/sink down, or the rubric had the coin ranked out). (${barNote}.)`);
  console.log('Feed the missed count into the n=20 graduation checkpoint — the track record is a floor, not the population.');
}

run(main);
