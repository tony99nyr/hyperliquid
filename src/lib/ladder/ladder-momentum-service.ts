/**
 * Momentum indicators for ladder `indicator` rungs (I/O bridge).
 *
 * Publishes the deterministic momentum-stall composite (pure math in
 * src/lib/health/momentum-stall-business-logic) into the watcher's per-coin
 * snapshot as named indicators:
 *
 *   momentum-stall-long  = how many of the 3 stall signals flipped AGAINST a long (0-3)
 *   momentum-stall-short = same, against a short
 *
 * A momentum-EXIT rung is then: triggerKind 'indicator', triggerMeta
 * { indicatorName: 'momentum-stall-long', op: 'above', indicatorValue: 2,
 *   floorPx: <only-beyond-this-price> } on a reduce/close rung. EXIT-ONLY is
 * enforced at arm time (validateLadderForArm) — an indicator can never open/add.
 *
 * Inputs: the COMPLETED 15m candles the watcher already fetched, plus the
 * recorded market_snapshots series (taker_flow / book_imbalance — NULL = not
 * measured, never 0). Fail-soft: any read/compute error returns null and the
 * evaluator fails closed (the rung just doesn't fire this tick).
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import type { PriceCandle } from '@/types/trading-core';
import { MOMENTUM_STALL_LONG, MOMENTUM_STALL_SHORT } from './ladder-types';
import {
  momentumStallVerdict,
  type MomentumCandle,
  type MomentumSeriesPoint,
} from '@/lib/health/momentum-stall-business-logic';

// Indicator names live in ladder-types (the pure SSOT shared with the evaluator +
// arm validation); this service just publishes values under them.

/** Snapshot series window backing the tape/book signals (~5 min cadence → ~18 points). */
const SERIES_WINDOW_MS = 90 * 60 * 1000;

async function readSeries(client: SupabaseClient, coin: string, now: number): Promise<MomentumSeriesPoint[]> {
  const { data, error } = await client
    .from('market_snapshots')
    .select('taker_flow, book_imbalance, captured_at')
    .eq('coin', coin.toUpperCase())
    .gte('captured_at', new Date(now - SERIES_WINDOW_MS).toISOString())
    .order('captured_at', { ascending: false })
    .limit(60);
  if (error || !data) return [];
  // Newest-60 then restored to ascending: an ascending LIMIT would keep the OLDEST
  // rows if the window ever out-grows the limit (review nit — harmless at the ~5min
  // cadence today, wrong the day the cadence tightens).
  // NULL = not measured (0032 rule) — preserve null, never coerce to 0.
  return (data as Array<{ taker_flow: unknown; book_imbalance: unknown }>).reverse().map((r) => ({
    takerFlow: r.taker_flow == null ? null : Number(r.taker_flow),
    bookImbalance: r.book_imbalance == null ? null : Number(r.book_imbalance),
  }));
}

/**
 * Compute both momentum-stall indicator values for one coin from the candles the
 * watcher already holds. `candles` is the RAW series (last element = in-progress
 * bar) — the in-progress bar is dropped here, matching §3.4. Returns null on any
 * failure (the evaluator then fails closed for indicator rungs on this coin).
 */
export async function computeMomentumIndicators(
  coin: string,
  candles: PriceCandle[],
  now: number,
  client: SupabaseClient = getServiceRoleClient(),
): Promise<Record<string, number> | null> {
  try {
    if (!Array.isArray(candles) || candles.length < 2) return null;
    const completed: MomentumCandle[] = candles.slice(0, -1).map((c) => ({
      openPx: c.open,
      closePx: c.close,
      highPx: c.high,
      lowPx: c.low,
      volume: c.volume,
    }));
    const series = await readSeries(client, coin, now);
    const long = momentumStallVerdict({ side: 'long', candles: completed, series });
    const short = momentumStallVerdict({ side: 'short', candles: completed, series });
    return {
      [MOMENTUM_STALL_LONG]: long.flipped.length,
      [MOMENTUM_STALL_SHORT]: short.flipped.length,
    };
  } catch {
    return null; // fail closed at the evaluator
  }
}
