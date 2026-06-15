/**
 * Health-snapshot service (I/O). Persists one health-engine result per
 * assessment cycle (score / P(continuation) / P(adverse) / alerts) so the UI
 * HealthPanel can live-render it via Supabase realtime. Thin write over the
 * service-role client; row shape from the PURE `buildHealthSnapshotRow`.
 */

import { getServiceRoleClient } from './supabase-server';
import { buildHealthSnapshotRow } from './cockpit-rows-business-logic';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Write a health snapshot for a session. */
export async function writeHealthSnapshot(
  input: {
    sessionId: string;
    score: number;
    pContinuation: number;
    pAdverse: number;
    alerts: string[];
  },
  client: SupabaseClient = getServiceRoleClient(),
): Promise<void> {
  const row = buildHealthSnapshotRow(input);
  const { error } = await client.from('health_snapshots').insert(row);
  if (error) throw new Error(`writeHealthSnapshot failed: ${error.message}`);
}
