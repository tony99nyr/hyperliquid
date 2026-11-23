/**
 * scout-heartbeat — the ONE liveness write, in a slim module on purpose.
 *
 * The prod cron lambdas (reconcile-positions, auto-exit) stamp a heartbeat each
 * run (retro 2026-10-03: the six-week silent cron death). They used to import it
 * from scout-watch-service, which drags fs, the HL info service, the reversion
 * scanner and session reads into every cron bundle. This module imports ONLY the
 * Supabase client. Daemon-side callers may keep using the scout-watch-service
 * re-export; anything that runs in a lambda should import from HERE.
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { STALE_AFTER_MS } from './scout-heartbeat-alert-business-logic';

/** Upsert a liveness heartbeat so the cockpit can show "scout last tick Nm ago"
 * and a hung/dead daemon (crash, OAuth expiry) is detectable. Best-effort. */
export async function writeScoutHeartbeat(
  status: string,
  detail: string,
  source = 'scout-watch',
  now: number = Date.now(),
): Promise<void> {
  try {
    await getServiceRoleClient()
      .from('scout_heartbeat')
      .upsert({ source, last_tick_at: new Date(now).toISOString(), status, detail }, { onConflict: 'source' });
  } catch {
    /* best-effort liveness */
  }
}

/**
 * Call on a DEGRADED reconcile run, before its heartbeat write. When the previous run is
 * older than the staleness threshold (the route was dead: a bearer, the Vercel CPU cap,
 * an outage), restart the degraded clock: move 'reconcile-ok' up to now. An outage of
 * 30+ min then never counts as degraded, so one skip on the first run back cannot page
 * "RECONCILE DEGRADED 2h", even when the watchdog was down too. Best-effort.
 */
export async function restartDegradedClockAfterOutage(now: number = Date.now()): Promise<void> {
  try {
    const client = getServiceRoleClient();
    const { data, error } = await client.from('scout_heartbeat').select('last_tick_at').eq('source', 'reconcile').maybeSingle();
    if (error) return;
    const last = data ? Date.parse(String((data as { last_tick_at: string }).last_tick_at)) : NaN;
    if (Number.isFinite(last) && now - last <= STALE_AFTER_MS.reconcile) return;
    await client.from('scout_heartbeat').update({ last_tick_at: new Date(now).toISOString() }).eq('source', 'reconcile-ok');
  } catch {
    /* best-effort */
  }
}
