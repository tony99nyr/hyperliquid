/**
 * Lane scorecard SERVICE (I/O). The single compute point for the scout's
 * account-level + per-lane breakdown, so the `scout:review` terminal, the
 * persisted UI snapshot (`lane_scorecards`), and the cockpit all show the SAME
 * numbers. Reuses the PURE helpers (buildScorecard / buildLaneScorecards /
 * vaultReturnSince / fundingCarryBenchmark). NEVER trades.
 *
 *   computeScoutLaneCards() → { account, lanes }   (reads DB + HL, no writes)
 *   persistScoutLaneCards(cards) → upsert lane_scorecards (service-role)
 *
 * Lanes: directional (from the paper ledger), vault:HLP + carry (passive
 * BENCHMARKS scored from live HL history — see SCOUT_ALPHA_ROADMAP.md).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { scoutSessionIds } from './scout-session-service';
import { fetchVaultDetails, HLP_VAULT_ADDRESS } from '@/lib/hyperliquid/hyperliquid-info-service';
import { fetchFundingHistory } from '@/lib/hyperliquid/candle-service';
import { estimateScoutFunding, type ScoutFill } from './scout-funding-business-logic';
import { lanePeriodDays, registeredLaneBar } from './scout-lane-bars-business-logic';
import {
  buildScorecard,
  buildLaneScorecards,
  DEFAULT_SCORECARD_CONFIG,
  type ScorecardInput,
  type LanePositionRow,
  type LaneHypothesisRow,
} from './scout-review-business-logic';
import { vaultReturnSince } from './vault-snapshot-business-logic';
import { fundingCarryBenchmark } from './funding-carry-business-logic';
import type { LaneCard, LaneKind } from '@/types/scout';

export type { LaneCard, LaneKind } from '@/types/scout';

const env = (k: string, d: number) => Number(process.env[k]) || d;
const CARRY_ROUNDTRIP_FRAC = 0.003; // ~30bps to put on + take off a delta-neutral pair

export interface ScoutLaneResult {
  account: LaneCard;
  lanes: LaneCard[]; // directional/position lanes + vault + carry (benchmarks)
  hasSessions: boolean;
}

/**
 * Compute the account-level scorecard + every lane card. Reads the scout paper
 * ledger (DB) and live HL history (vaultDetails, funding). Fail-soft on the
 * benchmarks (a failed fetch drops that lane, never throws the whole compute).
 */
export async function computeScoutLaneCards(
  now: number = Date.now(),
  client: SupabaseClient = getServiceRoleClient(),
): Promise<ScoutLaneResult> {
  // Robust identity: the old `.eq('title','scout')` matched ZERO sessions after the
  // scout session was archived — the kill/graduate bar read $0 forever (Jul-16 review).
  const sessionIds = await scoutSessionIds(client);
  const queryIds = sessionIds.length > 0 ? sessionIds : ['00000000-0000-0000-0000-000000000000'];

  const { data: positions, error: positionsError } = await client
    .from('positions').select('session_id, coin, side, lane, realized_pnl_usd, fees_paid_usd').in('session_id', queryIds);
  if (positionsError) throw positionsError;
  let realizedGrossUsd = 0;
  let openCount = 0;
  let feesPaidUsd = 0;
  let grossWinsUsd = 0;
  for (const p of positions ?? []) {
    const r = p as { side: string; realized_pnl_usd: number; fees_paid_usd: number };
    if (r.side !== 'flat') openCount++;
    realizedGrossUsd += (Number(r.realized_pnl_usd) || 0) - (Number(r.fees_paid_usd) || 0);
    feesPaidUsd += Number(r.fees_paid_usd) || 0;
    // Per-position positive realized as the gross-wins proxy (fee-drag denominator).
    grossWinsUsd += Math.max(0, Number(r.realized_pnl_usd) || 0);
  }

  const { data: fills, error: fillsError } = await client
    .from('fills').select('session_id, coin, side, sz, px, filled_at').in('session_id', queryIds);
  if (fillsError) throw fillsError;
  const scoutFills = (fills ?? []) as ScoutFill[];
  const earliestFillMs = Math.min(...scoutFills.map((fill) => Date.parse(fill.filled_at)).filter(Number.isFinite));
  const coins = [...new Set(scoutFills.map((fill) => fill.coin.toUpperCase()))];
  const history = await Promise.all(coins.map(async (coin) => ({
    coin, points: await fetchFundingHistory(coin, earliestFillMs, now).catch(() => []),
  })));
  const laneBySessionCoin: Record<string, string> = {};
  for (const p of positions ?? []) {
    const row = p as { session_id: string; coin: string; lane: string | null };
    laneBySessionCoin[`${row.session_id}\u0000${row.coin.toUpperCase()}`] = row.lane || 'directional';
  }
  const funding = estimateScoutFunding(scoutFills, laneBySessionCoin,
    Object.fromEntries(history.map(({ coin, points }) => [coin, points])), now);
  const { totalUsd: fundingHaircutUsd, earliestMs } = funding;
  const periodDays = Number.isFinite(earliestMs) ? Math.max(1, (now - earliestMs) / 86_400_000) : 1;

  const { data: hyps, error: hypothesesError } = await client
    .from('hypotheses')
    .select('status, lane, realized_r')
    .eq('excluded', false) // janitorial/reaped rows are NOT trades (Jul-16 quarantine)
    .in('session_id', queryIds);
  if (hypothesesError) throw hypothesesError;
  let wins = 0, losses = 0, closed = 0;
  for (const h of hyps ?? []) {
    const st = (h as { status: string }).status;
    if (st === 'confirmed') { wins++; closed++; }
    else if (st === 'invalidated') { losses++; closed++; }
    else if (st === 'resolved') closed++;
  }

  // Account-level (ALL lanes) — the bar the circuit breaker + graduation gate on.
  const accountInput: ScorecardInput = { realizedGrossUsd, slippageHaircutUsd: 0, fundingHaircutUsd, tradeCount: closed, wins, losses, periodDays, feesPaidUsd, grossWinsUsd };
  const acc = buildScorecard(accountInput);
  const fundingMissingHours = Object.values(funding.missingHoursByLane).reduce((a, b) => a + b, 0);
  const account: LaneCard = {
    lane: 'ALL', kind: 'account', netUsd: acc.netUsd, realizedUsd: acc.realizedGrossUsd, fundingUsd: acc.fundingHaircutUsd,
    unrealizedUsd: 0, tradeCount: acc.tradeCount, winRate: acc.winRate, monthlyRunRateUsd: acc.monthlyRunRateUsd,
    periodDays, verdict: fundingMissingHours > 0 && acc.verdict === 'graduate' ? 'incomplete' : acc.verdict,
    label: `${acc.reason}${fundingMissingHours ? ` Funding estimate misses ${fundingMissingHours} historical hours.` : ''}`,
    openCount, detail: { vsBarUsd: acc.vsBarUsd, fundingMissingHours },
  };

  const lanes: LaneCard[] = [];

  // Directional / position lanes.
  const lanePositions: LanePositionRow[] = (positions ?? []).map((p) => {
    const r = p as { coin: string; side: string; lane: string | null; realized_pnl_usd: number; fees_paid_usd: number };
    return { lane: r.lane ?? null, coin: r.coin, side: r.side, realizedPnlUsd: Number(r.realized_pnl_usd) || 0, feesPaidUsd: Number(r.fees_paid_usd) || 0 };
  });
  const laneHyps: LaneHypothesisRow[] = (hyps ?? []).map((h) => {
    const r = h as { status: string; lane: string | null; realized_r: number | null };
    return { lane: r.lane ?? null, status: r.status, realizedR: r.realized_r };
  });
  for (const { lane, openCount: lo, card: c } of buildLaneScorecards({
    positions: lanePositions, hypotheses: laneHyps, fundingByLane: funding.byLane, periodDays,
    periodDaysFor: (lane) => lanePeriodDays(lane, now, periodDays),
    configFor: (lane) => registeredLaneBar(lane)?.config ?? DEFAULT_SCORECARD_CONFIG,
    minExpectancyRFor: (lane) => registeredLaneBar(lane)?.minExpectancyR ?? null,
  })) {
    const laneDays = lanePeriodDays(lane, now, periodDays);
    const missingHours = funding.missingHoursByLane[lane] ?? 0;
    lanes.push({
      lane, kind: 'positions', netUsd: c.netUsd, realizedUsd: c.realizedGrossUsd, fundingUsd: c.fundingHaircutUsd,
      unrealizedUsd: 0, tradeCount: c.tradeCount, winRate: c.winRate, monthlyRunRateUsd: c.monthlyRunRateUsd,
      periodDays: laneDays, verdict: missingHours > 0 && c.verdict === 'graduate' ? 'incomplete' : c.verdict, openCount: lo,
      label: `net $${c.netUsd.toFixed(2)} · ${c.tradeCount} trades · win ${(c.winRate * 100).toFixed(0)}%${missingHours ? ` · funding estimate missing ${missingHours}h` : ''}`,
      detail: { fundingMissingHours: missingHours, barVersion: registeredLaneBar(lane)?.version ?? null, reason: c.reason },
    });
  }

  // Lane A — passive HLP vault allocation (flow-free return benchmark).
  try {
    const lookbackDays = env('SCOUT_VAULT_LOOKBACK_DAYS', 30);
    const notional = env('SCOUT_VAULT_NOTIONAL_USD', 1000);
    const bar = env('SCOUT_VAULT_BAR_USD', 50);
    const raw = await fetchVaultDetails(HLP_VAULT_ADDRESS);
    const { returnFrac, navUsd, spanDays } = vaultReturnSince(raw, now - lookbackDays * 86_400_000);
    if (returnFrac != null) {
      const days = Math.max(1, spanDays ?? lookbackDays);
      const v = buildScorecard({ realizedGrossUsd: 0, slippageHaircutUsd: 0, fundingHaircutUsd: 0, unrealizedPnlUsd: notional * returnFrac, tradeCount: 0, wins: 0, losses: 0, periodDays: days }, { ...DEFAULT_SCORECARD_CONFIG, monthlyBarUsd: bar });
      lanes.push({
        lane: 'vault:HLP', kind: 'vault', netUsd: v.netUsd, realizedUsd: 0, fundingUsd: 0, unrealizedUsd: notional * returnFrac,
        tradeCount: 0, winRate: 0, monthlyRunRateUsd: v.monthlyRunRateUsd, periodDays: days, verdict: v.verdict, openCount: 0,
        label: `HLP buy-hold $${notional} → ${(returnFrac * 100).toFixed(2)}% over ${days.toFixed(0)}d (bar $${bar})`,
        detail: { returnFrac, navUsd, notional, bar, lookbackDays },
      });
    }
  } catch { /* vault lane unavailable this cycle */ }

  // Lane B — delta-neutral funding carry (best liquid major).
  try {
    const lookbackDays = env('SCOUT_CARRY_LOOKBACK_DAYS', 30);
    const notional = env('SCOUT_CARRY_NOTIONAL_USD', 1000);
    const bar = env('SCOUT_CARRY_BAR_USD', 50);
    const since = now - lookbackDays * 86_400_000;
    const benches = await Promise.all(
      ['ETH', 'BTC', 'SOL', 'HYPE'].map(async (coin) => ({ coin, b: fundingCarryBenchmark(await fetchFundingHistory(coin, since).catch(() => [])) })),
    );
    const best = benches.filter((x) => x.b.heldHours > 0).sort((a, b) => b.b.carryReturnFrac - a.b.carryReturnFrac)[0];
    if (best) {
      const netFrac = best.b.carryReturnFrac - CARRY_ROUNDTRIP_FRAC;
      const days = Math.max(1, best.b.heldHours / 24);
      const c = buildScorecard({ realizedGrossUsd: 0, slippageHaircutUsd: 0, fundingHaircutUsd: 0, unrealizedPnlUsd: notional * netFrac, tradeCount: 0, wins: 0, losses: 0, periodDays: days }, { ...DEFAULT_SCORECARD_CONFIG, monthlyBarUsd: bar });
      lanes.push({
        lane: 'carry', kind: 'carry', netUsd: c.netUsd, realizedUsd: 0, fundingUsd: 0, unrealizedUsd: notional * netFrac,
        tradeCount: 0, winRate: 0, monthlyRunRateUsd: c.monthlyRunRateUsd, periodDays: days, verdict: c.verdict, openCount: 0,
        label: `${best.b.side} ${best.coin} $${notional} Δ-neutral → ${(best.b.carryReturnFrac * 100).toFixed(2)}% − ${(CARRY_ROUNDTRIP_FRAC * 100).toFixed(1)}% cost over ${days.toFixed(0)}d${best.b.exitedEarly ? ' [flipped→exit]' : ''}`,
        detail: { coin: best.coin, side: best.b.side, carryFrac: best.b.carryReturnFrac, costFrac: CARRY_ROUNDTRIP_FRAC, exitedEarly: best.b.exitedEarly, notional, bar },
      });
    }
  } catch { /* carry lane unavailable this cycle */ }

  return { account, lanes, hasSessions: sessionIds.length > 0 };
}

/**
 * Persist the latest lane cards (account + lanes) to `lane_scorecards` for the
 * cockpit to read. Single-writer: replace-all so a benchmark that switches coin
 * (carry:BTC→carry:ETH is keyed 'carry' so it just updates) never leaves stale rows.
 */
export async function persistScoutLaneCards(
  result: ScoutLaneResult,
  now: number = Date.now(),
  client: SupabaseClient = getServiceRoleClient(),
): Promise<void> {
  const all = [result.account, ...result.lanes];
  const rows = all.map((c) => ({
    lane: c.lane, kind: c.kind, net_usd: c.netUsd, realized_usd: c.realizedUsd, funding_usd: c.fundingUsd,
    unrealized_usd: c.unrealizedUsd, trade_count: c.tradeCount, win_rate: c.winRate, monthly_run_rate_usd: c.monthlyRunRateUsd,
    period_days: c.periodDays, verdict: c.verdict, label: c.label, open_count: c.openCount, detail: c.detail,
    updated_at: new Date(now).toISOString(),
  }));
  // Upsert on the lane PK (single writer). Update-in-place beats delete-then-insert:
  // no empty-table window if a write fails, no duplicate-key hazard, and a transient HL
  // outage that drops a benchmark this tick leaves the LAST-GOOD row (stale, not blank —
  // updated_at shows its age). Lanes are a stable set, so no orphan rows accrue.
  if (rows.length) {
    const { error } = await client.from('lane_scorecards').upsert(rows, { onConflict: 'lane' });
    if (error) throw new Error(`persistScoutLaneCards failed: ${error.message}`);
  }
}

/** Read the persisted lane cards for the cockpit. Cheap (one DB read, no HL). */
export async function readScoutLaneCards(
  client: SupabaseClient = getServiceRoleClient(),
): Promise<{ account: LaneCard | null; lanes: LaneCard[]; updatedAt: string | null }> {
  const { data, error } = await client
    .from('lane_scorecards')
    .select('lane, kind, net_usd, realized_usd, funding_usd, unrealized_usd, trade_count, win_rate, monthly_run_rate_usd, period_days, verdict, label, open_count, detail, updated_at');
  if (error || !data) return { account: null, lanes: [], updatedAt: null };
  const map = (r: Record<string, unknown>): LaneCard => ({
    lane: String(r.lane), kind: r.kind as LaneKind, netUsd: Number(r.net_usd) || 0, realizedUsd: Number(r.realized_usd) || 0,
    fundingUsd: Number(r.funding_usd) || 0, unrealizedUsd: Number(r.unrealized_usd) || 0, tradeCount: Number(r.trade_count) || 0,
    winRate: Number(r.win_rate) || 0, monthlyRunRateUsd: Number(r.monthly_run_rate_usd) || 0, periodDays: Number(r.period_days) || 0,
    verdict: String(r.verdict ?? ''), label: String(r.label ?? ''), openCount: Number(r.open_count) || 0,
    detail: (r.detail as Record<string, unknown>) ?? {},
  });
  const cards = (data as Record<string, unknown>[]).map(map);
  const account = cards.find((c) => c.kind === 'account') ?? null;
  const order = (k: LaneKind) => (k === 'positions' ? 0 : k === 'vault' ? 1 : k === 'carry' ? 2 : 3);
  const lanes = cards.filter((c) => c.kind !== 'account').sort((a, b) => order(a.kind) - order(b.kind));
  const updatedAt = (data as Array<{ updated_at?: string }>).map((r) => r.updated_at).filter(Boolean).sort().pop() ?? null;
  return { account, lanes, updatedAt };
}
