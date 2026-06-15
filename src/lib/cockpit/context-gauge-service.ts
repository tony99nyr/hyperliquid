/**
 * Context-gauge service (I/O). Writes Claude's rough self-reported context-usage
 * percent + the classified zone (ok / warn / critical) so the UI can warn the
 * human before Claude runs low mid-trade. The zone is derived by the PURE
 * `buildContextGaugeRow` (classifyContextZone: ok<60≤warn<85≤critical).
 */

import { getServiceRoleClient } from './supabase-server';
import { buildContextGaugeRow } from './cockpit-rows-business-logic';
import type { ContextZone } from '@/types/cockpit';
import type { SupabaseClient } from '@supabase/supabase-js';

export { classifyContextZone } from './cockpit-rows-business-logic';

/**
 * Write a context-gauge sample for a session. Returns the classified zone so the
 * caller (the report-context skill) can echo it without re-deriving.
 */
export async function writeContextGauge(
  input: { sessionId: string; approxPct: number },
  client: SupabaseClient = getServiceRoleClient(),
): Promise<ContextZone> {
  const row = buildContextGaugeRow(input);
  const { error } = await client.from('context_gauge').insert(row);
  if (error) throw new Error(`writeContextGauge failed: ${error.message}`);
  return row.zone;
}
