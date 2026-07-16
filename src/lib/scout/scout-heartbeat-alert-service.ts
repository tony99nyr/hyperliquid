/**
 * Scout heartbeat staleness alerts (I/O) — runs from the ladder-watch cron
 * tick (production, always on) so a dead scout box CANNOT be the thing that
 * fails to report a dead scout box. Fail-soft: alerting can never affect the
 * money path. Cooldown bookkeeping lives on the heartbeat row itself
 * (stale_alerted_at), cleared on recovery.
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';
import { heartbeatVerdict, staleMessage, STALE_AFTER_MS } from './scout-heartbeat-alert-business-logic';

export interface HeartbeatAlertSummary {
  checked: number;
  paged: number;
}

export async function checkScoutHeartbeats(now = Date.now()): Promise<HeartbeatAlertSummary> {
  try {
    const client = getServiceRoleClient();
    const { data, error } = await client
      .from('scout_heartbeat')
      .select('source, last_tick_at, stale_alerted_at')
      .in('source', Object.keys(STALE_AFTER_MS));
    if (error) return { checked: 0, paged: 0 };

    // ABSENT rows are the never-ran case — the watchdog's whole point (review F7).
    // Synthesize a maximally-stale row; the page path upserts an epoch tick so the
    // cooldown stamp has somewhere to live without looking fresh.
    const bySource = new Map<string, { last_tick_at: string; stale_alerted_at: string | null }>();
    for (const r of data ?? []) {
      bySource.set(String((r as { source: string }).source), r as { last_tick_at: string; stale_alerted_at: string | null });
    }

    let paged = 0;
    for (const source of Object.keys(STALE_AFTER_MS)) {
      const raw = bySource.get(source);
      const parsedTick = raw ? Date.parse(String(raw.last_tick_at)) : NaN;
      const parsedStamp = raw?.stale_alerted_at ? Date.parse(String(raw.stale_alerted_at)) : NaN;
      const row = {
        source,
        // Unparseable/absent tick => maximally stale (fail toward paging, review F7).
        lastTickAtMs: Number.isFinite(parsedTick) ? parsedTick : 0,
        staleAlertedAtMs: Number.isFinite(parsedStamp) ? parsedStamp : null,
      };
      const verdict = heartbeatVerdict(row, now);
      if (verdict === 'stale-page') {
        await sendDiscord(staleMessage(row, now), 'HL Scout Watchdog').catch(() => {});
        await client
          .from('scout_heartbeat')
          .upsert(
            { source, last_tick_at: new Date(row.lastTickAtMs).toISOString(), stale_alerted_at: new Date(now).toISOString() },
            { onConflict: 'source' },
          );
        paged++;
      }
    }
    return { checked: bySource.size, paged };
  } catch {
    return { checked: 0, paged: 0 };
  }
}
