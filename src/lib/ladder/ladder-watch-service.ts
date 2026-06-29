/**
 * runLadderWatchTick — the autonomous watcher (one tick). Loads ARMED ladders, builds a
 * completed-candle snapshot per touched coin, runs the PURE evaluator, and fires every
 * met PENDING rung through performLadderRungFire (which RE-VALIDATES the full guard
 * stack + the autofire kill-switch). Runs on Vercel cron, server-side — so it calls the
 * fire path directly (no cross-service POST) while the fire path stays the single
 * enforcement point. A no-op when autofire is off.
 *
 * §3.4: triggers are evaluated on COMPLETED candles only (snapshotFromCandleResult drops
 * the in-progress bar) and fail closed on a stale feed.
 */

import 'server-only';
import { isLadderAutofireEnabled } from './ladder-flags';
import { listLadders, getLadderWithRungs } from './ladder-service';
import { evaluateLadderRungs, type RungMarketSnapshot } from './ladder-trigger-evaluator';
import { snapshotFromCandleResult } from './ladder-watch-business-logic';
import { performLadderRungFire, type LadderFireResult } from './ladder-fire-service';
import type { LadderWithRungs } from './ladder-types';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import type { CandleInterval } from '@/lib/hyperliquid/candle-service-business-logic';

/** Timeframe whose CLOSED candle a price trigger evaluates against. A breakout is a
 *  completed-bar close across the level — 15m balances responsiveness vs whipsaw. */
const WATCH_INTERVAL: CandleInterval = '15m';
const WATCH_INTERVAL_MS = 15 * 60 * 1000;
const LOOKBACK_MS = 6 * 60 * 60 * 1000; // enough 15m bars for a couple completed candles
// Feed-freshness bound: the newest bar must be within 2 intervals of now, else fail closed.
const MAX_CANDLE_AGE_MS = 2 * WATCH_INTERVAL_MS;

export interface LadderWatchSummary {
  autofireOff: boolean;
  laddersEvaluated: number;
  rungsMet: number;
  rungsFired: number;
  fires: Array<{ ladderId: string; rungId: string; result: LadderFireResult }>;
}

export async function runLadderWatchTick(args: { now: number }): Promise<LadderWatchSummary> {
  const empty: LadderWatchSummary = { autofireOff: true, laddersEvaluated: 0, rungsMet: 0, rungsFired: 0, fires: [] };
  // Kill-switch: do NO work (no candle fetches, no fires) when autofire is off. The fire
  // path re-checks this too — this just avoids the cost when it's disabled.
  if (!isLadderAutofireEnabled()) return empty;

  const armedList = await listLadders('armed');
  if (armedList.length === 0) return { ...empty, autofireOff: false };

  // Load rungs for each armed ladder (listLadders omits them).
  const ladders = (await Promise.all(armedList.map((l) => getLadderWithRungs(l.id)))).filter((l): l is LadderWithRungs => !!l);

  // Distinct coins across PENDING rungs → one completed-candle snapshot each.
  const coins = new Set<string>();
  for (const l of ladders) for (const r of l.rungs) if (r.status === 'pending') coins.add(r.coin.toUpperCase());

  const snapshots: Record<string, RungMarketSnapshot> = {};
  await Promise.all(
    [...coins].map(async (coin) => {
      try {
        const res = await fetchCandles(coin, WATCH_INTERVAL, args.now - LOOKBACK_MS, args.now);
        snapshots[coin] = snapshotFromCandleResult(coin, res.candles, res.stale, { now: args.now, maxAgeMs: MAX_CANDLE_AGE_MS });
      } catch {
        snapshots[coin] = { coin, completedClose: 0, stale: true }; // fail closed
      }
    }),
  );

  let rungsMet = 0;
  let rungsFired = 0;
  const fires: LadderWatchSummary['fires'] = [];
  for (const l of ladders) {
    const evals = evaluateLadderRungs(l.rungs, snapshots);
    for (const e of evals) {
      if (!e.conditionMet) continue;
      rungsMet++;
      // performLadderRungFire owns ALL the safety (claim, precondition, guards, kill-switch).
      const result = await performLadderRungFire({ ladderId: l.id, rungId: e.rungId, now: args.now });
      if (result.fired) rungsFired++;
      fires.push({ ladderId: l.id, rungId: e.rungId, result });
    }
  }

  return { autofireOff: false, laddersEvaluated: ladders.length, rungsMet, rungsFired, fires };
}
