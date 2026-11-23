/**
 * Scout heartbeat staleness alerts (I/O) — runs from the ladder-watch cron
 * tick (production, always on) so a dead scout box CANNOT be the thing that
 * fails to report a dead scout box. Fail-soft: alerting can never affect the
 * money path. Cooldown bookkeeping lives on the heartbeat row itself
 * (stale_alerted_at), stamped after a page is sent; the 6h cooldown governs re-pages (never cleared by a fresh tick).
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';
import { heartbeatVerdict, healRow, staleMessage, HEAL_PARENT, STALE_AFTER_MS, type HeartbeatRow } from './scout-heartbeat-alert-business-logic';

export interface HeartbeatAlertSummary {
  checked: number;
  paged: number;
}

export async function checkScoutHeartbeats(now = Date.now()): Promise<HeartbeatAlertSummary> {
  try {
    const client = getServiceRoleClient();
    const { data, error } = await client
      .from('scout_heartbeat')
      .select('source, last_tick_at, stale_alerted_at, detail')
      .in('source', Object.keys(STALE_AFTER_MS));
    if (error) return { checked: 0, paged: 0 };

    // ABSENT rows are the never-ran case — the watchdog's whole point (review F7).
    // Synthesize a maximally-stale row; the page path upserts an epoch tick so the
    // cooldown stamp has somewhere to live without looking fresh.
    type Raw = { last_tick_at: string; stale_alerted_at: string | null; detail: string | null };
    const bySource = new Map<string, Raw>();
    for (const r of data ?? []) {
      bySource.set(String((r as { source: string }).source), r as Raw);
    }
    const tickMs = (raw: Raw | undefined): number | null => {
      const t = raw ? Date.parse(String(raw.last_tick_at)) : NaN;
      return Number.isFinite(t) ? t : null;
    };

    let paged = 0;
    for (const source of Object.keys(STALE_AFTER_MS)) {
      const raw = bySource.get(source);
      const parent = HEAL_PARENT[source];
      const parentRaw = parent === undefined ? undefined : bySource.get(parent);
      const parsedStamp = raw?.stale_alerted_at ? Date.parse(String(raw.stale_alerted_at)) : NaN;
      const own = {
        source,
        // Unparseable/absent tick => maximally stale (fail toward paging, review F7).
        lastTickAtMs: tickMs(raw) ?? 0,
        staleAlertedAtMs: Number.isFinite(parsedStamp) ? parsedStamp : null,
      };
      let row: HeartbeatRow | null = own;
      if (parent !== undefined) {
        if (raw === undefined) {
          // No healed run seen yet (first deploy, or a deleted row). Seed the row so the
          // degraded clock starts now, instead of never paging an already-degraded route.
          await client
            .from('scout_heartbeat')
            .upsert(
              { source, last_tick_at: new Date(now).toISOString(), status: 'seeded', detail: 'seeded by the watchdog: no healed run seen yet' },
              { onConflict: 'source', ignoreDuplicates: true },
            );
          continue;
        }
        row = healRow(own, tickMs(parentRaw), now);
        if (row === null) continue;
      }
      const verdict = heartbeatVerdict(row, now);
      if (verdict === 'stale-page') {
        const sent = await sendDiscord(staleMessage(row, now, parentRaw?.detail ?? null), 'HL Scout Watchdog').catch(() => false);
        // A failed send must not start the 6h cooldown: the next tick tries again. A send
        // that timed out after Discord posted it can repeat once per tick; that beats a lost page.
        if (!sent) continue;
        const stamp = new Date(now).toISOString();
        if (raw) {
          // Stamp only the cooldown: rewriting last_tick_at could undo a run that
          // landed between the read and this write.
          await client.from('scout_heartbeat').update({ stale_alerted_at: stamp }).eq('source', source);
        } else {
          await client
            .from('scout_heartbeat')
            .upsert({ source, last_tick_at: new Date(own.lastTickAtMs).toISOString(), stale_alerted_at: stamp }, { onConflict: 'source' });
        }
        paged++;
      }
    }
    return { checked: bySource.size, paged };
  } catch {
    return { checked: 0, paged: 0 };
  }
}
