/**
 * Expiry-approaching alert — PURE check (fixture-tested).
 *
 * An armed ladder that is about to expire with rungs still pending should page the
 * operator ONCE: either the window was too short / the level wrong (re-arm with a longer
 * expiry), or letting it die is intentional — but silence is never right (the 2026-07-01
 * ETH straddle expired unfired with no signal). Advisory-only: alerting changes nothing.
 */

import type { LadderWithRungs } from './ladder-types';

/** Alert when an armed ladder is within this of its expiry — but never more than a
 *  FRACTION of its own total window (armed→expiry), so a deliberately short-dated ladder
 *  (a 12h reversion fade) warns in its LAST QUARTER, not the moment it's armed. */
export const EXPIRY_ALERT_WINDOW_MS = 12 * 3_600_000;
export const EXPIRY_ALERT_WINDOW_FRAC = 0.25;

export interface ExpiryAlertVerdict {
  shouldAlert: boolean;
  message: string | null;
}

export function expiryAlertVerdict(
  ladder: Pick<LadderWithRungs, 'id' | 'title' | 'status' | 'expiresAt' | 'rungs'> & { armedAt?: string | null; expiryAlertAt?: string | null },
  now: number,
  windowMs: number = EXPIRY_ALERT_WINDOW_MS,
): ExpiryAlertVerdict {
  if (ladder.status !== 'armed') return { shouldAlert: false, message: null };
  if (ladder.expiryAlertAt) return { shouldAlert: false, message: null }; // already paged
  const expMs = ladder.expiresAt ? Date.parse(ladder.expiresAt) : NaN;
  if (!Number.isFinite(expMs)) return { shouldAlert: false, message: null };
  // Effective window = min(fixed 12h, 25% of the ladder's own armed→expiry span). A 4-day
  // event straddle still warns ~12h out; a 12h reversion fade warns in its last ~3h — not
  // instantly on arm (the bug: a fixed 12h trips any ≤12h-window ladder at arm time).
  const armedMs = ladder.armedAt ? Date.parse(ladder.armedAt) : NaN;
  const totalWindow = Number.isFinite(armedMs) ? expMs - armedMs : Number.POSITIVE_INFINITY;
  const effWindow = Math.min(windowMs, EXPIRY_ALERT_WINDOW_FRAC * totalWindow);
  if (expMs <= now || expMs - now > effWindow) return { shouldAlert: false, message: null };

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
