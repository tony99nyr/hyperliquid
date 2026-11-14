/**
 * Daily channel read (I/O) for the htf-trend live expression: fetch the daily candles,
 * select the completed bars by timestamp, and return the frozen read. Used by the watcher
 * (exit indicators) and by the htf-trend drafter (breakout detection).
 *
 * Fail closed: a stale, errored, late or gapped feed returns null, and so does any read in
 * the first minute after the daily close. The watcher then
 * publishes no exit indicator (the rung cannot fire; the exchange stop still protects the
 * position) and the drafter drafts nothing.
 */

import 'server-only';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { DAY_MS, HTF_SETTLE_MS, htfDailyRead, htfExitIndicators, utcDayStart, type HtfDailyRead } from './ladder-htf-exit-business-logic';

/** Daily bars requested. The read needs 22 completed bars; the margin costs nothing. */
const LOOKBACK_DAYS = 40;
/** A read taken this soon after the daily close is used but not kept for the day: a later
 *  read replaces it, in case the venue corrects the bar that just closed. */
const MEMO_SETTLE_MS = 5 * 60 * 1000;

// Completed daily bars do not change, so one good read serves the whole UTC day.
const memo = new Map<string, HtfDailyRead>();

/** The completed-daily htf-trend read for `coin` at `now`, or null (fail closed). */
export async function readHtfDaily(coin: string, now: number): Promise<HtfDailyRead | null> {
  const normCoin = coin.trim().toUpperCase();
  const dayStart = utcDayStart(now);
  const key = `${normCoin}:${dayStart}`;
  const hit = memo.get(key);
  if (hit) return hit;
  // Fail closed for the first minute of the day: no exit fires and no draft is made on a
  // bar that closed seconds ago.
  if (now - dayStart < HTF_SETTLE_MS) return null;

  const res = await fetchCandles(normCoin, '1d', now - LOOKBACK_DAYS * DAY_MS, now);
  if (res.stale || res.error) return null;
  const daily = htfDailyRead(res.candles, now);
  if (!daily) return null;
  if (now - dayStart >= MEMO_SETTLE_MS) {
    for (const k of memo.keys()) if (k.startsWith(`${normCoin}:`)) memo.delete(k);
    memo.set(key, daily);
  }
  return daily;
}

/** The daily channel exit indicators for `coin`, or null when the read fails closed. */
export async function computeHtfExitIndicators(coin: string, now: number): Promise<Record<string, number> | null> {
  try {
    const daily = await readHtfDaily(coin, now);
    return daily ? htfExitIndicators(daily.read) : null;
  } catch {
    return null;
  }
}

/** Test seam: clear the per-day memo. */
export function __resetHtfDailyMemo(): void {
  memo.clear();
}
