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

export interface RunawayAlertResult {
  scanned: number;
  candidates: number;
  drafted: Array<{ coin: string; side: string; movePct: number; ladderId: string }>;
  skippedDedup: string[];
  skippedPositioned: string[];
  cappedOut: number;
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

/** A recent runaway draft already exists for this coin? Ignores archived_at on purpose —
 *  archiving is the operator's "not this one" and must start the cooldown. FAIL-CLOSED:
 *  a dedupe read error throws into the per-coin catch (skip, no spray). */
async function alreadyDrafted(coin: string, sinceMs: number): Promise<boolean> {
  const db = getServiceRoleClient();
  const { data, error } = await db
    .from('ladders')
    .select('id')
    .ilike('title', `${coin} runaway%`)
    .gte('created_at', new Date(sinceMs).toISOString())
    .limit(1);
  if (error) throw new Error(`runaway dedupe read failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Run one runaway-alert cycle. READ-heavy + DRAFT writes only; never arms or fires. */
export async function runRunawayAlertCycle(
  coins: string[] = DEFAULT_COINS,
  now: number = Date.now(),
): Promise<RunawayAlertResult> {
  const ctxs = await fetchMetaAndAssetCtxs(validateEnv().HL_NETWORK).catch(() => null);
  if (!ctxs) return { scanned: 0, candidates: 0, drafted: [], skippedDedup: [], skippedPositioned: [], cappedOut: 0 };

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
  let cappedOut = 0;

  const positioned = hits.length > 0 ? await openPositionCoins() : new Set<string>();

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
        await sendDiscord(runawayAlertMessage(hit, ladderId, validateEnv().COCKPIT_BASE_URL), 'HL Runaway Desk').catch(() => {});
      }
    } catch {
      /* per-coin fail-soft — one coin's failure never blocks the rest */
    }
  }

  return { scanned, candidates: hits.length, drafted, skippedDedup, skippedPositioned, cappedOut };
}
