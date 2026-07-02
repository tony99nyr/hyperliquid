/**
 * Ladder OUTCOME ledger persistence (SERVICE ROLE, server-only).
 *
 * One row per ladder in `ladder_outcomes` (migration 0027) — upserted by the resolve
 * script (skill:ladder-expectancy). Read by the weekly expectancy review. Advisory data:
 * writing an outcome never touches the ladder itself or any order.
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import type { LadderOutcomeRow } from '@/lib/skills/ladder-expectancy-business-logic';

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToOutcome(r: any): LadderOutcomeRow {
  return {
    ladderId: r.ladder_id,
    title: r.title,
    coin: r.coin,
    side: r.side,
    mode: r.mode,
    setupType: r.setup_type,
    signalScore: r.signal_score ?? null,
    timingScore: r.timing_score ?? null,
    plannedRiskUsd: r.planned_risk_usd,
    realizedPnlUsd: r.realized_pnl_usd ?? null,
    feesUsd: r.fees_usd ?? null,
    realizedR: r.realized_r ?? null,
    outcome: r.outcome,
    windowStartMs: Date.parse(r.window_start),
    windowEndMs: r.window_end ? Date.parse(r.window_end) : null,
    notes: r.notes ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Upsert one outcome (keyed by ladder_id — re-resolving an 'open' outcome updates it). */
export async function upsertLadderOutcome(o: LadderOutcomeRow): Promise<void> {
  const db = getServiceRoleClient();
  const { error } = await db.from('ladder_outcomes').upsert(
    {
      ladder_id: o.ladderId,
      title: o.title,
      coin: o.coin,
      side: o.side,
      mode: o.mode,
      setup_type: o.setupType,
      signal_score: o.signalScore,
      timing_score: o.timingScore,
      planned_risk_usd: o.plannedRiskUsd,
      realized_pnl_usd: o.realizedPnlUsd,
      fees_usd: o.feesUsd,
      realized_r: o.realizedR,
      outcome: o.outcome,
      window_start: new Date(o.windowStartMs).toISOString(),
      window_end: o.windowEndMs != null ? new Date(o.windowEndMs).toISOString() : null,
      resolved_at: new Date().toISOString(),
      notes: o.notes,
    },
    { onConflict: 'ladder_id' },
  );
  if (error) throw new Error(`upsertLadderOutcome failed: ${error.message}`);
}

/** All outcomes (newest first) — the weekly review's input. */
export async function listLadderOutcomes(): Promise<LadderOutcomeRow[]> {
  const db = getServiceRoleClient();
  const { data, error } = await db.from('ladder_outcomes').select('*').order('resolved_at', { ascending: false });
  if (error) throw new Error(`listLadderOutcomes failed: ${error.message}`);
  return (data ?? []).map(rowToOutcome);
}

/** Fire statuses per ladder (batch) — 'filled' is the "an entry actually happened" signal. */
export async function fireStatusesByLadder(ladderIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ladderIds.length === 0) return out;
  const db = getServiceRoleClient();
  const { data, error } = await db.from('ladder_fires').select('ladder_id,status').in('ladder_id', ladderIds);
  if (error) throw new Error(`fireStatusesByLadder failed: ${error.message}`);
  for (const r of data ?? []) {
    const id = r.ladder_id as string;
    (out.get(id) ?? out.set(id, []).get(id)!).push(r.status as string);
  }
  return out;
}
