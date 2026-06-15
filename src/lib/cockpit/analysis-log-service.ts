/**
 * Analysis-log service (I/O). Appends a line to Claude's live analysis stream
 * for a session (rendered live in the UI via Supabase realtime). Thin write over
 * the service-role client; row shape from the PURE `buildAnalysisLogRow`.
 */

import { getServiceRoleClient } from './supabase-server';
import { buildAnalysisLogRow } from './cockpit-rows-business-logic';
import type { AlertSeverity } from '@/types/cockpit';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Write one analysis-log entry for a session. */
export async function writeAnalysisLog(
  input: { sessionId: string; source: string; message: string; severity?: AlertSeverity },
  client: SupabaseClient = getServiceRoleClient(),
): Promise<void> {
  const row = buildAnalysisLogRow(input);
  const { error } = await client.from('analysis_log').insert(row);
  if (error) throw new Error(`writeAnalysisLog failed: ${error.message}`);
}
