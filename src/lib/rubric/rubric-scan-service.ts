/**
 * Rubric SCAN orchestration (I/O). Two passes with different cadences:
 *  - runRubricScan: score all coins → portfolio cap → write rubric_scores (~20min).
 *  - runRubricReviews: for each OPEN position, health + verdict → position_reviews (~5min).
 * Pure scoring is delegated to the business-logic; this fetches, composes, writes.
 * Writes are upsert-ignore-duplicates on the unique key so identical re-runs are no-ops.
 */

import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { listActiveSessions } from '@/lib/cockpit/session-service';
import { loadOpenPositions } from '@/lib/cockpit/fill-persistence-service';
import { assessHealth } from '@/lib/health/health-engine';
import { loadRubricConfig, resolveCoinConfig } from './rubric-config';
import { assembleInputs } from './rubric-inputs-service';
import { computeRubric } from './rubric-composer-business-logic';
import { applyPortfolioCaps, type OpenLeg } from './rubric-portfolio-business-logic';
import { reviewPosition } from './rubric-position-review-business-logic';
import { buildRubricScoreRows, buildPositionReviewRow } from './rubric-rows-business-logic';
import { scoreBookImbalance } from './rubric-scorers-business-logic';
import { fetchSpotCoinBalance } from '@/lib/hyperliquid/hyperliquid-info-service';
import { computeLeaderDerisk, type DeriskAction } from './leader-derisk-business-logic';
import type { RubricInputs, RubricResult, Side } from './rubric-types';

/** Per-coin leader de-risk signal from the recent action stream (last ~2h). Best-effort. */
async function recentLeaderDerisk(now: number): Promise<Record<string, number>> {
  try {
    const since = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const { data } = await getServiceRoleClient()
      .from('leader_actions')
      .select('coin, kind, size_delta, entry_px')
      .gte('detected_at', since)
      .limit(20000);
    const actions: DeriskAction[] = (data ?? []).map((r) => {
      const a = r as { coin: string; kind: string; size_delta: number; entry_px: number | null };
      return { coin: a.coin, kind: a.kind as DeriskAction['kind'], sizeDelta: Number(a.size_delta) || 0, entryPx: a.entry_px };
    });
    return computeLeaderDerisk(actions);
  } catch {
    return {};
  }
}

/** Retain ~60 days of market snapshots (enough for momentum/cascade backtests). */
/** Hyperliquid's Assistance Fund system address (public; hypurrscan tracks it). */
const ASSISTANCE_FUND_ADDRESS = '0xfefefefefefefefefefefefefefefefefefefefe';

const SNAPSHOT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000; // 180d — this series is the desk's free OI/funding/flow history; keep it long

/** Open (non-flat) legs across all active sessions, for the portfolio cap. */
async function gatherOpenLegs(): Promise<Array<OpenLeg & { sessionId: string }>> {
  const sessions = await listActiveSessions();
  const legs: Array<OpenLeg & { sessionId: string }> = [];
  for (const s of sessions) {
    let positions;
    try {
      positions = await loadOpenPositions(s.id);
    } catch {
      continue;
    }
    for (const p of positions) {
      if (p.side !== 'flat' && p.sz > 0) legs.push({ coin: p.coin.toUpperCase(), side: p.side, sessionId: s.id });
    }
  }
  return legs;
}

/** Full opportunity scan: score every coin, apply the portfolio cap, persist. */
export async function runRubricScan(opts: { now: number }): Promise<{ scored: number; coins: string[] }> {
  const cfgBase = loadRubricConfig();
  // Per-coin leader de-risk signal (computed once; fed onto inputs so the veto
  // gate can see it, and stored on the snapshot for backtesting). Veto is OFF by
  // default, so this is inert on the score until a backtest enables it.
  const deriskByCoin = await recentLeaderDerisk(opts.now);
  const pairs: Array<{ inp: RubricInputs; result: RubricResult }> = [];
  for (const coin of cfgBase.universe) {
    const inp = await assembleInputs(coin, opts.now);
    if (!inp) continue;
    inp.derisk = deriskByCoin[coin.toUpperCase()] ?? null;
    pairs.push({ inp, result: computeRubric(inp, resolveCoinConfig(cfgBase, coin)) });
  }
  const openLegs = await gatherOpenLegs();
  const capped = applyPortfolioCaps(pairs.map((p) => p.result), openLegs, cfgBase);

  const rows = capped.flatMap((res, i) => buildRubricScoreRows(res, pairs[i].inp, cfgBase.version));
  if (rows.length > 0) {
    const client = getServiceRoleClient();
    const { error } = await client.from('rubric_scores').upsert(rows, {
      onConflict: 'coin,side,inputs_hash',
      ignoreDuplicates: true,
    });
    if (error) throw new Error(`rubric_scores upsert failed: ${error.message}`);
  }

  // Persist a market snapshot per coin (funding/OI/premium/leader-net/taker-flow/
  // book-imbalance time series) for future backtested lanes. The HYPE row also carries
  // the Assistance Fund's HYPE spot balance — its delta over time IS the fee-funded
  // buyback run-rate (the structural-bid gauge; address is HL's public system address).
  // Best-effort: a snapshot-write failure must never fail the scan.
  const afHypeBalance = await fetchSpotCoinBalance(ASSISTANCE_FUND_ADDRESS, 'HYPE');
  const snapshots = pairs
    .filter((p) => p.inp.ctx)
    .map((p) => ({
      captured_at: new Date(opts.now).toISOString(),
      coin: p.inp.coin.toUpperCase(),
      mark_px: p.inp.markPx,
      funding_hourly: p.inp.ctx!.fundingHourly,
      open_interest: p.inp.ctx!.openInterest,
      premium: p.inp.ctx!.premium,
      leader_net: p.inp.consensus.net,
      leader_derisk: deriskByCoin[p.inp.coin.toUpperCase()] ?? null,
      taker_flow: p.inp.takerFlow,
      book_imbalance: scoreBookImbalance(p.inp.book, cfgBase.gates.depthQueryFrac).imbalance,
      af_hype_balance: p.inp.coin.toUpperCase() === 'HYPE' ? afHypeBalance : null,
      config_version: cfgBase.version,
    }));
  if (snapshots.length > 0) {
    try {
      const client = getServiceRoleClient();
      await client.from('market_snapshots').insert(snapshots);
      // Bound growth: drop snapshots older than the retention window (the future
      // momentum/cascade lanes only need recent history). Best-effort.
      const cutoff = new Date(opts.now - SNAPSHOT_RETENTION_MS).toISOString();
      await client.from('market_snapshots').delete().lt('captured_at', cutoff);
    } catch {
      /* best-effort time series */
    }
  }
  return { scored: capped.length, coins: pairs.map((p) => p.result.coin) };
}

/** Per-open-position health + verdict. Recomputes the rubric only for HELD coins (cheap). */
export async function runRubricReviews(opts: { now: number }): Promise<{ reviewed: number }> {
  const cfgBase = loadRubricConfig();
  const legs = await gatherOpenLegs();
  if (legs.length === 0) return { reviewed: 0 };

  // Compute the rubric once per unique held coin.
  const heldCoins = [...new Set(legs.map((l) => l.coin))];
  const rubricByCoin = new Map<string, RubricResult>();
  for (const coin of heldCoins) {
    const inp = await assembleInputs(coin, opts.now);
    if (inp) rubricByCoin.set(coin, computeRubric(inp, resolveCoinConfig(cfgBase, coin)));
  }

  const client = getServiceRoleClient();
  const rows = [];
  for (const leg of legs) {
    const rubric = rubricByCoin.get(leg.coin);
    if (!rubric) continue;
    // Need the position's entry for the health context.
    let entryPx = 0;
    try {
      const positions = await loadOpenPositions(leg.sessionId);
      const pos = positions.find((p) => p.coin.toUpperCase() === leg.coin && p.side !== 'flat');
      if (!pos) continue;
      entryPx = pos.avgEntryPx;
    } catch {
      continue;
    }
    const health = await assessHealth(leg.coin, { side: leg.side, entryPx }, opts.now);
    const review = reviewPosition({ health, rubric, positionSide: leg.side as Side }, resolveCoinConfig(cfgBase, leg.coin));
    rows.push(
      buildPositionReviewRow(leg.sessionId, leg.coin, leg.side, review, health.pContinuation, health.pAdverse, health.alerts, cfgBase.version),
    );
  }
  if (rows.length > 0) {
    const { error } = await client.from('position_reviews').insert(rows);
    if (error) throw new Error(`position_reviews insert failed: ${error.message}`);
  }
  return { reviewed: rows.length };
}
