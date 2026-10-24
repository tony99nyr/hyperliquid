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
  // Floor at 30m (≥ the ~5m cron cadence): a deliberately SHORT-armed ladder has a tiny
  // FRAC×window (minutes) that can fall entirely between ticks — then the page the module
  // exists for is silently skipped and the ladder dies unpaged. A too-early page on a very
  // short ladder is the acceptable side of that trade (advisory + deduped, fires once).
  const MIN_EFF_WINDOW_MS = 30 * 60_000;
  const effWindow = Math.max(MIN_EFF_WINDOW_MS, Math.min(windowMs, EXPIRY_ALERT_WINDOW_FRAC * totalWindow));
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

export type ResidualRead =
  | { kind: 'unreadable' }
  | {
      kind: 'readable';
      positions: Array<{ coin: string; side: 'long' | 'short'; size: number }>;
      stops: Record<string, { triggerPx: number | null }> | null;
    };

/** A fired live entry can leave a position after its ladder stops managing it. */
export function residualExpiryAlertVerdict(
  ladder: Pick<LadderWithRungs, 'id' | 'title' | 'mode' | 'status' | 'rungs'>,
  read: ResidualRead,
): ExpiryAlertVerdict {
  if (ladder.status !== 'expired' || ladder.mode !== 'live') return { shouldAlert: false, message: null };
  const entries = ladder.rungs.filter((r) => r.status === 'fired' && (r.action === 'open' || r.action === 'add'));
  if (entries.length === 0) return { shouldAlert: false, message: null };
  const heading = `⏳ Ladder ${ladder.id.slice(0, 8)} "${ladder.title}" expired.`;
  if (read.kind === 'unreadable') {
    const coins = [...new Set(entries.map((r) => `${r.coin.toUpperCase()} ${r.side}`))].join(', ');
    return { shouldAlert: true, message: `${heading} Could not verify residual position or resting stop for ${coins}. Trailing and ladder management have stopped. Check HL and decide how to manage the exit.` };
  }
  const malformed = entries.some((r) => read.positions.some((p) =>
    p.coin.toUpperCase() === r.coin.toUpperCase() && p.side === r.side &&
    (!Number.isFinite(p.size) || p.size < 0)));
  if (malformed) {
    return { shouldAlert: true, message: `${heading} Could not verify residual position size. Trailing and ladder management have stopped. Check HL and decide how to manage the exit.` };
  }
  const residuals = [...new Set(entries.map((r) => `${r.coin.toUpperCase()}:${r.side}`))]
    .map((key) => {
      const [coin, side] = key.split(':') as [string, 'long' | 'short'];
      const position = read.positions.find((p) => p.coin.toUpperCase() === coin && p.side === side && Number.isFinite(p.size) && p.size > 0);
      if (!position) return null;
      const stopPx = read.stops?.[coin]?.triggerPx;
      const stop = stopPx != null && Number.isFinite(stopPx) && stopPx > 0
        ? `resting stop ${stopPx}` : 'resting stop could not be verified';
      return `${coin} ${side} ${position.size} coins, ${stop}`;
    }).filter((item): item is string => item !== null);
  if (residuals.length === 0) return { shouldAlert: false, message: null };
  return { shouldAlert: true, message: `${heading} Residual open on HL: ${residuals.join('; ')}. Trailing and ladder management have stopped. Decide whether to manage or close the position.` };
}
