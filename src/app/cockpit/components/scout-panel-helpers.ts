/**
 * PURE helpers for the ScoutPanel — track-record stats + status presentation from
 * the scout's hypotheses. No I/O. Fixture-tested.
 */

import type { Hypothesis, HypothesisStatus } from '@/types/cockpit';
import { ZONE_COLORS, GH } from './panel-styles';

export interface ScoutStats {
  open: number;
  wins: number; // confirmed
  losses: number; // invalidated
  resolved: number; // neutral closes
  /** Win rate over decided (confirmed + invalidated) theses, 0–1, or null when none decided. */
  winRate: number | null;
}

export function scoutStats(hyps: Hypothesis[]): ScoutStats {
  let open = 0;
  let wins = 0;
  let losses = 0;
  let resolved = 0;
  for (const h of hyps) {
    if (h.status === 'open') open++;
    else if (h.status === 'confirmed') wins++;
    else if (h.status === 'invalidated') losses++;
    else if (h.status === 'resolved') resolved++;
  }
  const decided = wins + losses;
  return { open, wins, losses, resolved, winRate: decided > 0 ? wins / decided : null };
}

export interface StatusMeta {
  label: string;
  color: string;
}

/** Color + short label for a hypothesis status chip. */
export function statusMeta(status: HypothesisStatus): StatusMeta {
  switch (status) {
    case 'open':
      return { label: 'OPEN', color: GH.textMuted };
    case 'confirmed':
      return { label: 'WIN', color: ZONE_COLORS.ok };
    case 'invalidated':
      return { label: 'LOSS', color: ZONE_COLORS.danger };
    case 'resolved':
      return { label: 'FLAT', color: GH.textMuted };
    default:
      return { label: String(status).toUpperCase(), color: GH.textMuted };
  }
}
