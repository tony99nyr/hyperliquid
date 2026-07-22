/**
 * Hypothesis service (I/O). Writes a trade thesis and resolves it later (when
 * the position is exited / the thesis is confirmed or invalidated). Thin writes
 * over the service-role client; insert row shape from the PURE
 * `buildHypothesisRow`.
 */

import { getServiceRoleClient } from './supabase-server';
import { buildHypothesisRow } from './cockpit-rows-business-logic';
import type { Hypothesis, HypothesisStatus } from '@/types/cockpit';
import type { SupabaseClient } from '@supabase/supabase-js';

interface HypothesisRow {
  id: string;
  session_id: string;
  created_at: string;
  statement: string;
  status: HypothesisStatus;
  resolved_at: string | null;
  resolution_note: string | null;
}

function toHypothesis(row: HypothesisRow): Hypothesis {
  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: new Date(row.created_at).getTime(),
    statement: row.statement,
    status: row.status,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).getTime() : null,
    resolutionNote: row.resolution_note,
  };
}

/** Create a new (open) hypothesis for a session. */
export async function writeHypothesis(
  input: {
    sessionId: string;
    statement: string;
    status?: HypothesisStatus;
    lane?: string;
    /** Structured trial fields (Jul-16 learning-loop review): risk at open so
     *  realized R is computable at close; setup taxonomy + regime so per-setup
     *  expectancy is deterministic instead of prose-mining. */
    riskUsd?: number;
    setupType?: string;
    regime?: string;
    coin?: string;
  },
  client: SupabaseClient = getServiceRoleClient(),
): Promise<Hypothesis> {
  const row = {
    ...buildHypothesisRow(input),
    ...(input.riskUsd !== undefined && Number.isFinite(input.riskUsd) ? { risk_usd: input.riskUsd } : {}),
    ...(input.setupType ? { setup_type: input.setupType.slice(0, 40) } : {}),
    ...(input.regime ? { regime: input.regime.slice(0, 40) } : {}),
  };
  const { data, error } = await client.from('hypotheses').insert(row).select().single();
  if (error) throw new Error(`writeHypothesis failed: ${error.message}`);
  return toHypothesis(data as HypothesisRow);
}

/**
 * Resolve a hypothesis: set its terminal status (confirmed / invalidated /
 * resolved), stamp resolved_at, and attach an optional note.
 */
export async function resolveHypothesis(
  input: {
    hypothesisId: string;
    status: Extract<HypothesisStatus, 'confirmed' | 'invalidated' | 'resolved'>;
    resolutionNote?: string | null;
    /** Structured outcome (Jul-16 review): realized P&L and R-multiple, so the
     *  track record is computable without parsing prose notes. */
    realizedPnlUsd?: number;
    realizedR?: number;
  },
  client: SupabaseClient = getServiceRoleClient(),
): Promise<void> {
  const { error } = await client
    .from('hypotheses')
    .update({
      status: input.status,
      resolved_at: new Date().toISOString(),
      resolution_note: input.resolutionNote ?? null,
      ...(input.realizedPnlUsd !== undefined && Number.isFinite(input.realizedPnlUsd) ? { realized_pnl_usd: input.realizedPnlUsd } : {}),
      ...(input.realizedR !== undefined && Number.isFinite(input.realizedR) ? { realized_r: input.realizedR } : {}),
    })
    .eq('id', input.hypothesisId);
  if (error) throw new Error(`resolveHypothesis failed: ${error.message}`);
}
