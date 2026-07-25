/**
 * reversion-alert (I/O) — the DISCOVERY→READY-TO-ARM bridge for the ONE proven-ish
 * edge. Scans for reversion-extreme dislocations on the live-book coins; on a FRESH
 * hit it creates a LOW-QTY LIVE ladder DRAFT (never armed — the operator arms) and
 * pings Discord so the operator gets one nudge with a plan already priced + reviewed.
 *
 * Discipline baked in: DRAFT only (never auto-arms — the human gate holds), deduped so
 * a persistent stretch drafts once per cooldown (not every tick), a hard per-cycle cap
 * so it can never spray drafts, short expiry so stale drafts self-clean. Fail-soft.
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { scanReversionExtremes } from '@/lib/scout/reversion-scan-service';
import { createLadder } from './ladder-service';
import { buildReversionLadderPlan, reversionAlertMessage, type ReversionAlertHit } from './reversion-alert-business-logic';
import { sendDiscord, isDiscordConfigured } from '@/lib/infrastructure/notify/discord-notify';

const DEFAULT_COINS = ['BTC', 'ETH', 'SOL', 'HYPE'];
const DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000; // one draft per coin per 6h episode
const MAX_DRAFTS_PER_CYCLE = 2; // hard cap — can never spray

export interface ReversionAlertResult {
  scanned: number;
  candidates: number;
  drafted: Array<{ coin: string; side: string; ladderId: string }>;
  skippedDedup: string[];
  cappedOut: number;
}

/** A recent live reversion-fade draft/armed ladder already exists for this coin?
 *  Deliberately IGNORES archived_at: archiving a draft is the operator's "not this
 *  one" — it must start the cooldown, not trigger an instant re-draft next tick. */
async function alreadyDrafted(coin: string, sinceMs: number): Promise<boolean> {
  const db = getServiceRoleClient();
  const { data, error } = await db
    .from('ladders')
    .select('id')
    .ilike('title', `${coin} reversion-fade%`)
    .gte('created_at', new Date(sinceMs).toISOString())
    .limit(1);
  // FAIL CLOSED: a dedupe read error must throw into the per-coin catch (skip, no
  // draft) — treating it as "not drafted" would spray a draft + ping every tick.
  if (error) throw new Error(`reversion dedupe read failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/**
 * Run one reversion-alert cycle. READ-heavy + DRAFT writes only; never arms or fires.
 * Returns a summary the cron logs. Fail-soft per coin — a blip on one never blocks others.
 */
export async function runReversionAlertCycle(
  coins: string[] = DEFAULT_COINS,
  now: number = Date.now(),
): Promise<ReversionAlertResult> {
  const { hits, coverage } = await scanReversionExtremes(coins, now).catch(() => ({
    hits: [] as Awaited<ReturnType<typeof scanReversionExtremes>>['hits'],
    coverage: { requested: coins.length, scanned: 0, skipped: coins.length },
  }));

  const drafted: ReversionAlertResult['drafted'] = [];
  const skippedDedup: string[] = [];
  let cappedOut = 0;

  for (const hit of hits) {
    if (drafted.length >= MAX_DRAFTS_PER_CYCLE) {
      cappedOut += 1;
      continue;
    }
    const coin = hit.coin.toUpperCase();
    try {
      if (await alreadyDrafted(coin, now - DEDUP_WINDOW_MS)) {
        skippedDedup.push(coin);
        continue;
      }
      const alertHit: ReversionAlertHit = {
        coin, side: hit.side, z: hit.z, er: hit.er, regime: hit.regime, regimeConf: hit.regimeConf,
        mark: hit.mark, stop: hit.stop, target: hit.target, stopFrac: hit.stopFrac,
      };
      const ladderId = await createLadder(buildReversionLadderPlan(alertHit, { now }));
      drafted.push({ coin, side: hit.side, ladderId });
      if (isDiscordConfigured()) {
        await sendDiscord(reversionAlertMessage(alertHit, ladderId), 'HL Reversion Scout').catch(() => {});
      }
    } catch {
      /* per-coin fail-soft — a draft/alert failure never blocks the rest of the cycle */
    }
  }

  return { scanned: coverage.scanned, candidates: hits.length, drafted, skippedDedup, cappedOut };
}
