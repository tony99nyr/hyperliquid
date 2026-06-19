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

export interface ScanCandidate {
  sessionId: string;
  coin: string;
}

/** Every open (non-flat) position across active sessions, as exit candidates. */
export async function listExitCandidates(): Promise<ScanCandidate[]> {
  const sessions = await listActiveSessions();
  const candidates: ScanCandidate[] = [];
  for (const session of sessions) {
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
