/**
 * Scout decision-context service (I/O) — assembles the enriched, ADVISORY
 * context for the cycle snapshot: tape (taker flow + book imbalance), the
 * leader book, the AF buy rate, and funding/OI percentiles vs each coin's own
 * `market_snapshots` history. Pure math lives in scout-context-business-logic.
 *
 * FAIL-SOFT BY DESIGN: every part degrades to null/[] independently — a missing
 * context section must never block the cycle (the scout just reasons without it).
 * READ-ONLY: HL info reads + Supabase selects; never trades, never writes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchRecentTrades, fetchL2Book } from '@/lib/hyperliquid/hyperliquid-info-service';
import { takerFlowFromTrades, scoreBookImbalance } from '@/lib/rubric/rubric-scorers-business-logic';
import { loadRubricConfig, resolveCoinConfig } from '@/lib/rubric/rubric-config';
import {
  percentileRank,
  summarizeLeaderBook,
  afDailyRate,
  type ScoutTapeRead,
  type ScoutLeaderRead,
  type ScoutPercentileRead,
  type LeaderPositionRow,
} from './scout-context-business-logic';

export interface ScoutContext {
  tape: ScoutTapeRead[];
  leaders: ScoutLeaderRead[];
  /** HYPE Assistance-Fund buy rate (HYPE/24h) from the recorded gauge; null = unknown. */
  afHypePerDay: number | null;
  percentiles: ScoutPercentileRead[];
}

/** History window backing the funding/OI percentiles. */
const PERCENTILE_LOOKBACK_MS = 14 * 24 * 3_600_000;

async function readTape(coin: string): Promise<ScoutTapeRead> {
  const cfg = resolveCoinConfig(loadRubricConfig(), coin);
  const [trades, book] = await Promise.all([
    fetchRecentTrades(coin).catch(() => null),
    fetchL2Book(coin).catch(() => null),
  ]);
  const takerFlow = trades ? takerFlowFromTrades(trades) : null;
  let bookImbalance: number | null = null;
  let spreadBps: number | null = null;
  if (book) {
    const b = scoreBookImbalance(book, cfg.gates.depthQueryFrac);
    bookImbalance = b.imbalance;
    spreadBps = Number.isFinite(b.spreadBps) ? b.spreadBps : null;
  }
  return { coin, takerFlow, bookImbalance, spreadBps };
}

async function readLeaders(client: SupabaseClient, coins: string[]): Promise<ScoutLeaderRead[]> {
  const { data, error } = await client
    .from('leader_positions')
    .select('coin, side, position_value')
    .in('coin', coins);
  if (error || !data) return [];
  return summarizeLeaderBook(data as LeaderPositionRow[]);
}

async function readAfRate(client: SupabaseClient, now: number): Promise<number | null> {
  const { data: latestRows } = await client
    .from('market_snapshots')
    .select('captured_at, af_hype_balance')
    .not('af_hype_balance', 'is', null)
    .order('captured_at', { ascending: false })
    .limit(1);
  const latest = latestRows?.[0] as { captured_at: string; af_hype_balance: unknown } | undefined;
  if (!latest) return null;
  // The earliest reading inside the last ~24h gives the widest honest window.
  const { data: earlierRows } = await client
    .from('market_snapshots')
    .select('captured_at, af_hype_balance')
    .not('af_hype_balance', 'is', null)
    .gte('captured_at', new Date(now - 24 * 3_600_000).toISOString())
    .order('captured_at', { ascending: true })
    .limit(1);
  const earlier = earlierRows?.[0] as { captured_at: string; af_hype_balance: unknown } | undefined;
  if (!earlier) return null;
  return afDailyRate(
    { atMs: new Date(latest.captured_at).getTime(), balance: Number(latest.af_hype_balance) },
    { atMs: new Date(earlier.captured_at).getTime(), balance: Number(earlier.af_hype_balance) },
  );
}

async function readPercentiles(
  client: SupabaseClient,
  coin: string,
  currentFunding: number | null,
  currentOi: number | null,
  now: number,
): Promise<ScoutPercentileRead> {
  // Newest ≤1000 points (Supabase's max-rows cap; ≈13.9d at the ~20min cadence —
  // effectively the full lookback window).
  const { data, error } = await client
    .from('market_snapshots')
    .select('funding_hourly, open_interest')
    .eq('coin', coin)
    .gte('captured_at', new Date(now - PERCENTILE_LOOKBACK_MS).toISOString())
    .order('captured_at', { ascending: false })
    .limit(1000);
  if (error || !data) return { coin, fundingPctile: null, oiPctile: null, sampleCount: 0 };
  const rows = data as Array<{ funding_hourly: unknown; open_interest: unknown }>;
  // NULL = NOT MEASURED, never 0 (the migration-0032 rule): coerce SQL null to NaN
  // so it's FILTERED, not injected into the distribution as a spurious zero.
  const num = (v: unknown): number => (v == null ? NaN : Number(v));
  const fundings = rows.map((r) => num(r.funding_hourly)).filter(Number.isFinite);
  const ois = rows.map((r) => num(r.open_interest)).filter(Number.isFinite);
  return {
    coin,
    fundingPctile: currentFunding != null ? percentileRank(fundings, currentFunding) : null,
    oiPctile: currentOi != null ? percentileRank(ois, currentOi) : null,
    // Conservative support: the SMALLER finite series (raw row count would overstate
    // what actually backed a percentile when one column has gaps).
    sampleCount: Math.min(fundings.length, ois.length),
  };
}

/**
 * Gather the full advisory context for the cycle snapshot. `fundingByCoin` /
 * `oiByCoin` carry the CURRENT values (the cycle already fetched them) so the
 * percentile frames the same number the model sees.
 */
export async function gatherScoutContext(
  coins: string[],
  fundingByCoin: Map<string, number>,
  oiByCoin: Map<string, number>,
  now: number = Date.now(),
  client: SupabaseClient = getServiceRoleClient(),
): Promise<ScoutContext> {
  const universe = [...new Set(coins.map((c) => c.trim().toUpperCase()))];
  const [tape, leaders, afHypePerDay, percentiles] = await Promise.all([
    Promise.all(universe.map((c) => readTape(c).catch(() => ({ coin: c, takerFlow: null, bookImbalance: null, spreadBps: null })))),
    readLeaders(client, universe).catch(() => []),
    readAfRate(client, now).catch(() => null),
    Promise.all(
      universe.map((c) =>
        readPercentiles(client, c, fundingByCoin.get(c) ?? null, oiByCoin.get(c) ?? null, now).catch(() => ({
          coin: c,
          fundingPctile: null,
          oiPctile: null,
          sampleCount: 0,
        })),
      ),
    ),
  ]);
  return { tape, leaders, afHypePerDay, percentiles };
}
