/**
 * pnpm cron:nas — the NAS share of the prod crons, one run per nas-watch.sh tick.
 *
 * Vercel Hobby caps Active CPU at 4 hours a month, so this tick skips the
 * /api/cron/auto-exit poke while the book is confirmed flat
 * (rules: src/lib/auto-exit/cron-poke-business-logic.ts):
 *
 * 1. It always pokes /api/cron/reconcile-positions first. The route books missed
 *    exchange fills, so the position count below sees them.
 * 2. When the reconcile ran completely, a strict count finds 0 open live positions
 *    and the last auto-exit poke did not fail, it stamps the 'auto-exit-cron'
 *    heartbeat itself. Otherwise, and on the first tick of each hour, it pokes the
 *    route, which re-verifies and is the only place that closes.
 * 3. When a poke fails, it marks both heartbeats 'nas-poke-failed' (keeping their
 *    tick times, so the staleness page still fires). scout:watch then pokes.
 *
 * NEVER trades. The poke bearer comes from AUTO_EXIT_CRON_SECRET (nas-watch.sh
 * exports it from the out-of-git secret file).
 */

import { run, line } from './_skill-runtime';
import { countLiveOpenPositions } from '@/lib/auto-exit/auto-exit-scan';
import { canSkipAutoExitPoke, NAS_POKE_FAILED, PROD_CRON_SOURCES, reconcileRanCompletely } from '@/lib/auto-exit/cron-poke-business-logic';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { writeScoutHeartbeat } from '@/lib/scout/scout-heartbeat-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

const BASE = process.env.HL_COCKPIT_URL ?? 'https://hyperliquid-rouge.vercel.app';

/** Poke a prod-cron route. `body` is the parsed JSON response, or null. */
async function poke(path: string): Promise<{ ok: boolean; body: unknown }> {
  const secret = process.env.AUTO_EXIT_CRON_SECRET;
  if (!secret) {
    line(`[cron:nas] SKIP poke ${path}: no AUTO_EXIT_CRON_SECRET`);
    return { ok: false, body: null };
  }
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${secret}`, 'X-Poker': 'nas' },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    line(`[cron:nas] poke ${path} -> HTTP ${res.status} ${text.slice(0, 400)}`);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* a non-JSON body leaves body null */
    }
    return { ok: res.ok, body };
  } catch (e) {
    line(`[cron:nas] poke ${path} failed: ${extractErrorMessage(e)}`);
    return { ok: false, body: null };
  }
}

/** Hand the prod crons to the office-box fallback now, not after the 12-min freshness window. */
async function markNasPokeFailed(): Promise<void> {
  try {
    const { error } = await getServiceRoleClient()
      .from('scout_heartbeat')
      .update({ status: NAS_POKE_FAILED })
      .in('source', [...PROD_CRON_SOURCES]);
    if (error) line(`[cron:nas] could not mark the heartbeats failed: ${error.message}`);
  } catch (e) {
    line(`[cron:nas] could not mark the heartbeats failed: ${extractErrorMessage(e)}`);
  }
}

async function readAutoExitStatus(): Promise<string | null> {
  try {
    const { data, error } = await getServiceRoleClient()
      .from('scout_heartbeat')
      .select('status')
      .eq('source', 'auto-exit-cron')
      .maybeSingle();
    if (error || !data) return null;
    return (data as { status: string | null }).status;
  } catch {
    return null;
  }
}

/** The UTC minute at the START of the nas-watch tick (NAS_TICK_UTC_MINUTE), so a slow
 * tick still lands its hourly probe. Falls back to the current minute. */
function tickUtcMinute(): number {
  const m = Number.parseInt(process.env.NAS_TICK_UTC_MINUTE ?? '', 10);
  return Number.isInteger(m) && m >= 0 && m < 60 ? m : new Date().getUTCMinutes();
}

async function main(): Promise<void> {
  const reconcile = await poke('/api/cron/reconcile-positions');
  const reconcileComplete = reconcileRanCompletely(reconcile.ok, reconcile.body);

  let liveOpenPositions: number | null = null;
  try {
    liveOpenPositions = await countLiveOpenPositions();
  } catch (e) {
    line(`[cron:nas] live position count failed, poking auto-exit: ${extractErrorMessage(e)}`);
  }

  const lastAutoExitStatus = await readAutoExitStatus();
  let autoExitOk = true;
  if (canSkipAutoExitPoke({ reconcileComplete, liveOpenPositions, lastAutoExitStatus, utcMinute: tickUtcMinute() })) {
    line('[cron:nas] auto-exit: no live position open, Vercel poke skipped');
    await writeScoutHeartbeat('ok', 'auto-exit skipped: no live position open via nas-local', 'auto-exit-cron');
  } else {
    autoExitOk = (await poke('/api/cron/auto-exit')).ok;
  }

  if (!reconcile.ok || !autoExitOk) {
    await markNasPokeFailed();
    process.exitCode = 1;
  }
}

run(main);
