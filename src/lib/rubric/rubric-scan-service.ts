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
import type { RubricInputs, RubricResult, Side } from './rubric-types';

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
  const pairs: Array<{ inp: RubricInputs; result: RubricResult }> = [];
  for (const coin of cfgBase.universe) {
    const inp = await assembleInputs(coin, opts.now);
    if (!inp) continue;
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
