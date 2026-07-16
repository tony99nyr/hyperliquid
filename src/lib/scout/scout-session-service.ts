/**
 * Scout session identity — THE one resolver for "which sessions belong to the
 * scout". The Jul-16 review found BOTH the cycle's self-memory and the
 * kill/graduate scorecard filtering on `title = 'scout'`, which matched ZERO
 * sessions after the scout session was archived (renamed
 * `scout-archived-2026-06-26`) — the bar read $0 forever and every cycle ran
 * cold-start. This resolver is intentionally broad and paper-only:
 *
 *   scout sessions = paper sessions titled `scout` or `scout-archived%`
 *                  ∪ paper sessions that own a hypotheses row (scout-trade is
 *                    the hypothesis writer in the paper lane)
 *
 * Never returns live sessions (the scout must not even SEE the live lane —
 * the Jul-14 incident rule).
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function scoutSessionIds(client: SupabaseClient = getServiceRoleClient()): Promise<string[]> {
  const ids = new Set<string>();

  const { data: titled } = await client
    .from('sessions')
    .select('id, title')
    .eq('mode', 'paper')
    .or('title.eq.scout,title.like.scout-archived%');
  for (const s of titled ?? []) ids.add((s as { id: string }).id);

  // Lane-tagged rows only (review F4): scout-trade ALWAYS writes a lane; the human
  // skills (open-position/run-session) never do — this keeps pre-go-live manual
  // paper sessions out of the scout's self-record. Ordered so a >1000-row future
  // truncates the OLDEST, never an arbitrary slice (review F8).
  const { data: hyp } = await client
    .from('hypotheses')
    .select('session_id')
    .not('lane', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1000);
  const hypIds = Array.from(new Set((hyp ?? []).map((h) => (h as { session_id: string }).session_id)));
  if (hypIds.length > 0) {
    const { data: paperOwners } = await client
      .from('sessions')
      .select('id')
      .eq('mode', 'paper')
      .in('id', hypIds);
    for (const s of paperOwners ?? []) ids.add((s as { id: string }).id);
  }

  return Array.from(ids);
}
