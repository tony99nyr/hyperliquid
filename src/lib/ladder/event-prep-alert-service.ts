/**
 * Event-prep alert (I/O) — the standing reminder for scheduled macro events. When an
 * event from the calendar (economic-events.ts) enters its prep window (default T−30min),
 * it 🚨 Discord-pings the operator with the exact `straddle:prep` command + the ladders
 * link, so the event straddle is built off a FRESH pre-print reference and armed in time.
 *
 * ADVISORY ONLY — pings + logs, never trades/arms/drafts. Deduped so it fires ONCE per
 * event (a stamp in analysis_log). Runs fail-soft from the ladder-watch cron each tick.
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { prepDueEvent } from '@/lib/skills/event-calendar-business-logic';
import { sendDiscord, isDiscordConfigured } from '@/lib/infrastructure/notify/discord-notify';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { validateEnv } from '@/lib/env/env';
import { getTradingMode } from '@/lib/env/mode';

export interface EventPrepAlertResult {
  pinged: string | null;
  skipped?: string;
}

export async function runEventPrepAlert(now: number = Date.now()): Promise<EventPrepAlertResult> {
  const e = prepDueEvent(now);
  if (!e) return { pinged: null, skipped: 'no-event-in-prep-window' };

  const db = getServiceRoleClient();
  // Dedup: fire ONCE per event. The stamp is an analysis_log row; re-check it before pinging
  // (window ≥ the whole prep lead + buffer). A read error → skip (never spam on a bad read).
  const since = new Date(now - 3 * 60 * 60 * 1000).toISOString();
  const { data: seen, error } = await db
    .from('analysis_log')
    .select('id')
    .eq('source', 'event-prep-alert')
    .ilike('message', `%${e.name}%`)
    .gte('created_at', since)
    .limit(1);
  if (error) return { pinged: null, skipped: 'dedup-read-failed' };
  if ((seen?.length ?? 0) > 0) return { pinged: null, skipped: 'already-alerted' };

  const minsOut = Math.max(0, Math.round(e.msOut / 60_000));
  const coin = e.straddleCoin ?? 'BTC';

  // Resolve the dedup home (most-recent session) and WRITE THE STAMP BEFORE pinging.
  // The stamp is the whole dedup — the read above keys off it — so if we can't persist it,
  // we must NOT ping (a ping with no stamp re-fires every ~5m tick for the entire prep
  // window). Fail-closed: no session or a failed write → skip this tick, retry next.
  // The stamp is only an FK home for the dedup row — the dedup READ above is GLOBAL (keyed
  // on source+message+time), so which session owns the stamp is cosmetic. PREFER a same-mode
  // session (keep a live event-prep row off a paper lane), but FALL BACK to any session so the
  // ping is NEVER suppressed just because no same-mode session exists (fresh-deploy edge).
  let sess = (await db.from('sessions').select('id').eq('mode', getTradingMode()).order('created_at', { ascending: false }).limit(1)).data;
  if (!sess?.length) {
    sess = (await db.from('sessions').select('id').order('created_at', { ascending: false }).limit(1)).data;
  }
  const sid = (sess?.[0] as { id: string } | undefined)?.id;
  if (!sid) return { pinged: null, skipped: 'no-session-to-dedup-against' };
  try {
    await writeAnalysisLog({
      sessionId: sid,
      source: 'event-prep-alert',
      severity: 'warn',
      message: `Event prep window: ${e.name} in ~${minsOut}m — pinged to prep + arm the ${coin} straddle.`,
    });
  } catch {
    return { pinged: null, skipped: 'dedup-write-failed' };
  }

  const base = validateEnv().COCKPIT_BASE_URL.replace(/\/$/, '');
  const msg =
    `🚨 **${e.name} in ~${minsOut} min — PREP + ARM THE STRADDLE NOW**\n` +
    `\`pnpm straddle:prep --coin ${coin} --event ${e.name} --print ${new Date(e.atMs).toISOString()}\`\n` +
    `Drafts the two OCO legs off the LIVE pre-print reference — then arm in the cockpit ` +
    `👉 ${base}/cockpit?tab=ladders  (don't hold naked directional risk through the print).`;
  if (isDiscordConfigured()) await sendDiscord(msg, 'HL Event Desk').catch(() => {});
  return { pinged: e.name };
}
