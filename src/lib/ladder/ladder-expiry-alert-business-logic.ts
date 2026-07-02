/**
 * Expiry-approaching alert — PURE check (fixture-tested).
 *
 * An armed ladder that is about to expire with rungs still pending should page the
 * operator ONCE: either the window was too short / the level wrong (re-arm with a longer
 * expiry), or letting it die is intentional — but silence is never right (the 2026-07-01
 * ETH straddle expired unfired with no signal). Advisory-only: alerting changes nothing.
 */

import type { LadderWithRungs } from './ladder-types';

/** Alert when an armed ladder is within this of its expiry. */
export const EXPIRY_ALERT_WINDOW_MS = 12 * 3_600_000;

export interface ExpiryAlertVerdict {
  shouldAlert: boolean;
  message: string | null;
}

export function expiryAlertVerdict(
  ladder: Pick<LadderWithRungs, 'id' | 'title' | 'status' | 'expiresAt' | 'rungs'> & { expiryAlertAt?: string | null },
  now: number,
  windowMs: number = EXPIRY_ALERT_WINDOW_MS,
): ExpiryAlertVerdict {
  if (ladder.status !== 'armed') return { shouldAlert: false, message: null };
  if (ladder.expiryAlertAt) return { shouldAlert: false, message: null }; // already paged
  const expMs = ladder.expiresAt ? Date.parse(ladder.expiresAt) : NaN;
  if (!Number.isFinite(expMs)) return { shouldAlert: false, message: null };
  if (expMs <= now || expMs - now > windowMs) return { shouldAlert: false, message: null };

  const pending = ladder.rungs.filter((r) => r.status === 'pending');
  if (pending.length === 0) return { shouldAlert: false, message: null }; // fully terminal — nothing at stake
  const pendingEntries = pending.filter((r) => r.action === 'open' || r.action === 'add').length;
  const pendingExits = pending.length - pendingEntries;
  const hoursLeft = Math.max(0, (expMs - now) / 3_600_000);

  const what = pendingEntries > 0
    ? `${pendingEntries} entry rung(s)${pendingExits ? ` + ${pendingExits} exit rung(s)` : ''} still pending — it will die unfired`
    : `${pendingExits} exit rung(s) still pending — automated scale-outs stop at expiry (the resting stop remains)`;
  return {
    shouldAlert: true,
    message: `⏳ Ladder ${ladder.id.slice(0, 8)} "${ladder.title}" expires in ~${hoursLeft.toFixed(1)}h with ${what}. Re-arm with a longer window / adjusted levels, or let it lapse deliberately.`,
  };
}
