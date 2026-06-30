/**
 * External dead-man's-switch ping (healthchecks.io style).
 *
 * The ladder-watch cron pings this each tick; if pings stop arriving within the check's
 * Period + Grace, the EXTERNAL monitor alerts. This catches a TOTAL app/cron outage that a
 * self-hosted heartbeat could not — because then the thing that would send the alert is the
 * thing that died. Ping flow per tick: `/start` → run → bare-URL on success, `/fail` on error
 * (the monitor measures run duration + flips to "down" on a fail or a missed window).
 *
 * Best-effort by construction: a monitoring ping must NEVER break or delay the watcher, so
 * `pingHealthcheck` swallows every error and bounds itself with a short timeout.
 */

export type HealthcheckSignal = 'start' | 'success' | 'fail';

/**
 * Build the ping URL for a signal. PURE (unit-tested). `success` pings the bare base; `start`
 * and `fail` append the healthchecks.io sub-path. Trailing slashes are trimmed. Returns null
 * for a missing/blank base so callers no-op cleanly when monitoring isn't configured.
 */
export function healthcheckUrl(base: string | undefined | null, signal: HealthcheckSignal): string | null {
  const trimmed = base?.trim();
  if (!trimmed) return null;
  const root = trimmed.replace(/\/+$/, '');
  return signal === 'success' ? root : `${root}/${signal}`;
}

/**
 * Fire the ping. Never throws; aborts after `timeoutMs` so a hung monitor can't stall the
 * tick. Awaited by the caller (on serverless the function can freeze after the response, so
 * we must finish the ping before returning) — but bounded, and failure is silently ignored.
 */
export async function pingHealthcheck(
  base: string | undefined | null,
  signal: HealthcheckSignal,
  timeoutMs = 3000,
): Promise<void> {
  const url = healthcheckUrl(base, signal);
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { method: 'GET', signal: controller.signal });
  } catch {
    /* monitoring must never break the watcher */
  } finally {
    clearTimeout(timer);
  }
}
