/**
 * runaway-alert (I/O) — the DISCOVERY→READY-TO-ARM bridge for the momentum-catalyst
 * doctrine ("strong movements ARE a catalyst", operator 2026-08-19, after the HYPE +19%
 * day produced no vehicle). Scans the majors' 24h move; on a fresh RUNAWAY hit it
 * creates a LOW-QTY LIVE ladder DRAFT (never armed — the operator panel-gates + arms)
 * and pings Discord with a plan already priced.
 *
 * Discipline baked in (mirrors reversion-alert-service): DRAFT only, deduped per coin
 * per cooldown, hard per-cycle cap, short expiry, book-aware (never drafts onto a coin
 * the operator already holds), fail-soft per coin.
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchMetaAndAssetCtxs, fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { createLadder } from './ladder-service';
import { detectRunaway, buildRunawayLadderPlan, runawayAlertMessage } from './runaway-alert-business-logic';
import { sendDiscord, isDiscordConfigured } from '@/lib/infrastructure/notify/discord-notify';
import { validateEnv } from '@/lib/env/env';

const DEFAULT_COINS = ['BTC', 'ETH', 'SOL', 'HYPE'];
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // one draft per coin per 24h episode
const MAX_DRAFTS_PER_CYCLE = 2; // hard cap — can never spray
/** The majors move as ONE beta bet (the panel's correlated-exposure rule): when this
 *  many distinct majors already have a current draft/armed ladder, stop drafting more —
 *  a third correlated vehicle just invites the operator to overfill the book (08-21:
 *  ETH drafted while BTC+SOL sat armed at the panel's full $15 cap). */
const MAX_MAJORS_WITH_VEHICLES = 2;

export interface RunawayAlertResult {
  scanned: number;
  candidates: number;
  drafted: Array<{ coin: string; side: string; movePct: number; ladderId: string }>;
  skippedDedup: string[];
  skippedPositioned: string[];
  cappedOut: number;
  /** Per-coin failures (dedupe read / createLadder). Surfaced — a silently-failing
   *  drafter is the "dead consumer" class this desk has been burned by (review 08-20). */
  errors: string[];
}

/** Coins with a live open position right now. FAIL-OPEN on a read blip (a draft is only
 *  a draft — the operator reviews it), same rationale as the reversion drafter. */
async function openPositionCoins(): Promise<Set<string>> {
  try {
    const address = getHlAccountAddress();
    if (!address) return new Set();
    const state = await fetchClearinghouseState(address, { uncached: true });
    return new Set(state.positions.map((p) => p.coin.toUpperCase()));
  } catch {
    return new Set();
  }
}

/** Does this coin already have a VEHICLE? Two checks (first firing's lesson, 08-20: the
 *  drafter re-created a panel-VETOED HYPE geometry because it only looked for its own
 *  titles while a panel-approved HYPE draft sat right there):
 *   1. a recent runaway draft (title match, archived included — archiving is the
 *      operator's "not this one" and must start the cooldown);
 *   2. ANY current draft/armed live ladder whose rungs touch the coin — the operator
 *      (or the panel) already has a vehicle; a second mechanical one is clutter at best
 *      and a vetoed-shape resurrection at worst.
 *  FAIL-CLOSED: a read error throws into the per-coin catch (skip, no spray). */
async function alreadyDrafted(coin: string, sinceMs: number): Promise<boolean> {
  const db = getServiceRoleClient();
  const { data, error } = await db
    .from('ladders')
    .select('id')
    .ilike('title', `${coin} runaway%`)
    .gte('created_at', new Date(sinceMs).toISOString())
    .limit(1);
  if (error) throw new Error(`runaway dedupe read failed: ${error.message}`);
  if ((data?.length ?? 0) > 0) return true;
  const { data: rungRows, error: rungErr } = await db
    .from('ladder_rungs')
    .select('ladder_id, ladders!inner(status, archived_at)')
    .eq('coin', coin)
    .in('ladders.status', ['draft', 'armed'])
    .is('ladders.archived_at', null)
    .limit(1);
  if (rungErr) throw new Error(`runaway vehicle-check read failed: ${rungErr.message}`);
  return (rungRows?.length ?? 0) > 0;
}

/** Run one runaway-alert cycle. READ-heavy + DRAFT writes only; never arms or fires. */
export async function runRunawayAlertCycle(
  coins: string[] = DEFAULT_COINS,
  now: number = Date.now(),
): Promise<RunawayAlertResult> {
  const ctxs = await fetchMetaAndAssetCtxs(validateEnv().HL_NETWORK).catch(() => null);
  if (!ctxs) return { scanned: 0, candidates: 0, drafted: [], skippedDedup: [], skippedPositioned: [], cappedOut: 0, errors: ['assetCtxs fetch failed'] };

  const hits = [];
  let scanned = 0;
  for (const coin of coins) {
    const ctx = ctxs[coin.toUpperCase()];
    if (!ctx) continue;
    scanned++;
    const hit = detectRunaway({ coin, mark: ctx.markPx, prevDayPx: ctx.prevDayPx });
    if (hit) hits.push(hit);
  }

  const drafted: RunawayAlertResult['drafted'] = [];
  const skippedDedup: string[] = [];
  const skippedPositioned: string[] = [];
  const errors: string[] = [];
  let cappedOut = 0;

  const positioned = hits.length > 0 ? await openPositionCoins() : new Set<string>();

  // Correlated-book gate: count DISTINCT majors that already carry a current
  // draft/armed ladder — at the cap, skip drafting entirely (fail-CLOSED on a read
  // error: not drafting is the cheap failure). One query, only when hits exist.
  if (hits.length > 0) {
    try {
      const db = getServiceRoleClient();
      const { data: rungRows, error } = await db
        .from('ladder_rungs')
        .select('coin, ladders!inner(status, archived_at)')
        .in('coin', DEFAULT_COINS)
        .in('ladders.status', ['draft', 'armed'])
        .is('ladders.archived_at', null);
      if (error) throw new Error(`correlated-book read failed: ${error.message}`);
      const majorsWithVehicles = new Set((rungRows ?? []).map((r) => String((r as { coin: string }).coin).toUpperCase()));
      if (majorsWithVehicles.size >= MAX_MAJORS_WITH_VEHICLES) {
        return {
          scanned, candidates: hits.length, drafted: [], skippedDedup: [], skippedPositioned: [],
          cappedOut: hits.length,
          errors: [`correlated-book cap: ${majorsWithVehicles.size} majors already have vehicles (${[...majorsWithVehicles].join(',')}) — not drafting more`],
        };
      }
    } catch (e) {
      return { scanned, candidates: hits.length, drafted: [], skippedDedup: [], skippedPositioned: [], cappedOut: 0, errors: [e instanceof Error ? e.message : String(e)] };
    }
  }

  for (const hit of hits) {
    if (drafted.length >= MAX_DRAFTS_PER_CYCLE) {
      cappedOut += 1;
      continue;
    }
    if (positioned.has(hit.coin)) {
      skippedPositioned.push(hit.coin);
      continue;
    }
    try {
      if (await alreadyDrafted(hit.coin, now - DEDUP_WINDOW_MS)) {
        skippedDedup.push(hit.coin);
        continue;
      }
      const ladderId = await createLadder(buildRunawayLadderPlan(hit, { now }));
      drafted.push({ coin: hit.coin, side: hit.side, movePct: hit.movePct24h, ladderId });
      if (isDiscordConfigured()) {
        // The ping IS this lane's product — a draft nobody hears about is a silent
        // failure, so a false/broken send gets logged (it lands in the cron response too).
        const sent = await sendDiscord(runawayAlertMessage(hit, ladderId, validateEnv().COCKPIT_BASE_URL), 'HL Runaway Desk').catch(() => false);
        if (!sent) {
          errors.push(`${hit.coin}: drafted ${ladderId.slice(0, 8)} but the Discord ping FAILED`);
          console.warn(`[runaway] ${hit.coin} draft ${ladderId.slice(0, 8)} created but Discord ping failed`);
        }
      }
    } catch (e) {
      // Per-coin fail-soft — but VISIBLY: a persistent dedupe/insert failure must not
      // silently disable the lane forever (the dead-consumer class).
      const msg = `${hit.coin}: ${e instanceof Error ? e.message : String(e)}`;
      errors.push(msg);
      console.warn(`[runaway] draft failed — ${msg}`);
    }
  }

  return { scanned, candidates: hits.length, drafted, skippedDedup, skippedPositioned, cappedOut, errors };
}
