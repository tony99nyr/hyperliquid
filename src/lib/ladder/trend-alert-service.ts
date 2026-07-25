/**
 * trend-alert (I/O) — the DISCOVERY→READY-TO-ARM bridge for the trend-follow lane
 * (the iamrossi retired-leverage-lane replacement). Each cycle it reads the 8h
 * trend stance; on a coin that is bullish+confident AND held over there, it creates
 * a LOW-QTY LIVE ladder DRAFT (never armed — the operator arms) and pings Discord
 * so the operator gets one nudge with a plan already priced.
 *
 * Discipline baked in: DRAFT only (never auto-arms — the human gate holds), deduped
 * per bullish episode (an existing active trend ladder for the coin, or one created
 * inside the cooldown, suppresses re-drafting), a hard per-cycle cap, fail-soft
 * everywhere. Stance unreadable ⇒ nothing drafts (fail-closed toward drafting).
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { createLadder } from './ladder-service';
import { fetchTrendStance, stanceFor, isBullishConfident, isTrendStanceConfigured } from './trend-stance-service';
import { buildTrendLadderPlan, trendAlertMessage, TREND_TITLE_PREFIX, type TrendAlertContext } from './trend-alert-business-logic';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { calculateATR } from '@/lib/strategy/indicators/indicators';
import { sendDiscord, isDiscordConfigured } from '@/lib/infrastructure/notify/discord-notify';

/** ETH first (the handoff's ask); BTC becomes a one-line addition once the lane earns it. */
const DEFAULT_COINS = ['ETH'];
/** One draft per coin per episode — a fresh draft only after this long with no active one. */
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_DRAFTS_PER_CYCLE = 1; // hard cap — can never spray
const ATR_PERIOD = 14;
const CANDLE_LOOKBACK_MS = 40 * 8 * 60 * 60 * 1000; // 40 8h candles ≫ ATR(14) warm-up

export interface TrendAlertResult {
  configured: boolean;
  stanceRead: boolean;
  considered: string[];
  drafted: Array<{ coin: string; ladderId: string }>;
  skipped: Array<{ coin: string; reason: string }>;
}

/**
 * An active or recent trend-follow ladder already covers this coin? Two legs, both
 * load-bearing:
 *  (a) LIVE coverage — a draft/armed trend ladder that has NOT passed its expiry.
 *      Drafts never transition to 'expired' (only armed ones do), so without the
 *      expires_at bound one ignored draft would suppress the lane FOREVER.
 *  (b) RECENCY — anything created inside the cooldown window REGARDLESS of status
 *      or archived_at. Archiving a draft is the operator's "not this one" gesture;
 *      it must start the cooldown, not trigger an instant re-draft + re-ping.
 */
async function alreadyDrafted(coin: string, now: number, sinceMs: number): Promise<boolean> {
  const db = getServiceRoleClient();
  const titlePattern = `${coin} ${TREND_TITLE_PREFIX}%`;
  const [active, recent] = await Promise.all([
    db
      .from('ladders')
      .select('id')
      .ilike('title', titlePattern)
      // 'done' counts as live coverage too: a fully-fired ladder leaves an OPEN
      // position under management — re-drafting a second pyramid on the same coin
      // mid-campaign invites stacking. Its expiry bound still frees the lane later.
      .in('status', ['draft', 'armed', 'done'])
      .is('archived_at', null)
      .gte('expires_at', new Date(now).toISOString())
      .limit(1),
    db
      .from('ladders')
      .select('id')
      .ilike('title', titlePattern)
      .gte('created_at', new Date(sinceMs).toISOString())
      .limit(1),
  ]);
  if (active.error) throw new Error(`trend-alert dedupe (active) failed: ${active.error.message}`);
  if (recent.error) throw new Error(`trend-alert dedupe (recent) failed: ${recent.error.message}`);
  return (active.data?.length ?? 0) > 0 || (recent.data?.length ?? 0) > 0;
}

/**
 * Run one trend-alert cycle. READ-heavy + DRAFT writes only; never arms or fires.
 * Returns a summary the cron logs. Fail-soft per coin — a blip on one never blocks others.
 */
export async function runTrendAlertCycle(
  coins: string[] = DEFAULT_COINS,
  now: number = Date.now(),
): Promise<TrendAlertResult> {
  const result: TrendAlertResult = { configured: isTrendStanceConfigured(), stanceRead: false, considered: [], drafted: [], skipped: [] };
  if (!result.configured) return result;

  const snapshot = await fetchTrendStance(now);
  if (!snapshot) return result; // unreadable stance ⇒ draft nothing (fail-closed)
  result.stanceRead = true;

  for (const rawCoin of coins) {
    const coin = rawCoin.toUpperCase();
    if (result.drafted.length >= MAX_DRAFTS_PER_CYCLE) {
      result.skipped.push({ coin, reason: 'cycle-cap' });
      continue;
    }
    try {
      const stance = stanceFor(snapshot, coin);
      result.considered.push(coin);
      if (!isBullishConfident(stance)) {
        result.skipped.push({ coin, reason: `stance:${stance ? `${stance.regime}/${Math.round(stance.regimeConfidence * 100)}%/${stance.position}` : 'absent'}` });
        continue;
      }
      if (await alreadyDrafted(coin, now, now - DEDUP_WINDOW_MS)) {
        result.skipped.push({ coin, reason: 'dedup' });
        continue;
      }

      const [mids, candleRes] = await Promise.all([
        fetchAllMids(),
        fetchCandles(coin, '8h', now - CANDLE_LOOKBACK_MS, now),
      ]);
      const mark = Number(mids[coin]);
      if (!Number.isFinite(mark) || mark <= 0) {
        result.skipped.push({ coin, reason: 'no-mark' });
        continue;
      }
      // ATR off COMPLETED candles only (drop the in-progress last bar).
      const candles = candleRes.candles.slice(0, -1);
      const atrSeries = calculateATR(candles, ATR_PERIOD);
      const atr = atrSeries[atrSeries.length - 1];
      if (!Number.isFinite(atr) || atr === undefined || atr <= 0) {
        result.skipped.push({ coin, reason: 'no-atr' });
        continue;
      }

      const ctx: TrendAlertContext = {
        coin,
        mark,
        atrFrac: atr / mark,
        regime: stance!.regime,
        regimeConfidence: stance!.regimeConfidence,
      };
      const ladderId = await createLadder(buildTrendLadderPlan(ctx, { now }));
      result.drafted.push({ coin, ladderId });
      if (isDiscordConfigured()) {
        await sendDiscord(trendAlertMessage(ctx, ladderId), 'HL Trend Scout').catch(() => {});
      }
    } catch (e) {
      // per-coin fail-soft — a draft/alert failure never blocks the rest of the cycle
      result.skipped.push({ coin, reason: `error:${e instanceof Error ? e.message.slice(0, 80) : 'unknown'}` });
    }
  }
  return result;
}
