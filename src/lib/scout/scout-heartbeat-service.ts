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
