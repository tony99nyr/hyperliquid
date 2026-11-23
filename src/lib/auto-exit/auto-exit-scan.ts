/**
 * Auto-exit scan (I/O) — enumerate the open positions to RE-VERIFY.
 *
 * Deliberately dumb: it lists every open position across active sessions and
 * returns (sessionId, coin) candidates. It makes NO exit decision and performs
 * NO execution — the authoritative decision + reduce-only close happen in
 * performRiskExit (which re-verifies each candidate from fresh data). Keeping the
 * decision in one place is what lets the lib/auto-exit no-execute invariant hold.
 */

import { listActiveSessions } from '@/lib/cockpit/session-service';
import { loadOpenPositions } from '@/lib/cockpit/fill-persistence-service';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ScanCandidate {
  sessionId: string;
  coin: string;
}

/** Every open (non-flat) position across active LIVE sessions, as exit candidates.
 *
 * LIVE-ONLY by construction (both consumers — the auto-exit fire path AND the liq
 * alert — act on the REAL account): a PAPER (scout) session's position must NEVER
 * enter this list, or the auto-exit closes the live account's same-coin position off
 * a paper signal (the 2026-07-28 cross-lane incident: a paper SOL long's health→0
 * flattened the live SOL short). The scout manages its own paper exits. */
export async function listExitCandidates(): Promise<ScanCandidate[]> {
  const sessions = await listActiveSessions();
  const candidates: ScanCandidate[] = [];
  for (const session of sessions) {
    if (session.mode !== 'live') continue; // paper positions are out of scope for the live auto-exit
    let positions;
    try {
      positions = await loadOpenPositions(session.id);
    } catch {
      continue; // fail soft per session
    }
    for (const p of positions) {
      if (p.side !== 'flat' && p.sz > 0) {
        candidates.push({ sessionId: session.id, coin: p.coin.toUpperCase() });
      }
    }
  }
  return candidates;
}

/** Open positions in active LIVE sessions, counted STRICTLY: any read error throws, so a
 * caller can tell "confirmed none" from "could not read" (listExitCandidates fails soft
 * to an empty list, which must never justify skipping the auto-exit). */
export async function countLiveOpenPositions(client: SupabaseClient = getServiceRoleClient()): Promise<number> {
  const { data: sessions, error } = await client.from('sessions').select('id').eq('status', 'active').eq('mode', 'live');
  if (error || !sessions) throw new Error(`live sessions read failed: ${error?.message ?? 'no data'}`);
  const ids = (sessions as Array<{ id: string }>).map((s) => s.id);
  if (ids.length === 0) return 0;
  const { count, error: posError } = await client
    .from('positions')
    .select('session_id', { count: 'exact', head: true })
    .in('session_id', ids)
    .neq('side', 'flat')
    .gt('sz', 0);
  if (posError || count === null) throw new Error(`live positions count failed: ${posError?.message ?? 'no count'}`);
  return count;
}
