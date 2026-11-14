/**
 * Daily channel read for the htf-trend live expression. PURE (no I/O, no clock).
 *
 * Two jobs:
 *  1. Select the COMPLETED daily bars from a candle series by TIMESTAMP, and refuse the
 *     series unless its newest completed bar is yesterday's UTC bar. A blind "drop the
 *     last bar" is not safe: when the venue has not yet published the new in-progress
 *     bar, the last bar IS the bar that just completed, and dropping it reads a day late.
 *  2. Turn the frozen scout read (`htfTrendRead`, imported, never edited here) into the
 *     exit indicators the watcher publishes: 1 when the latest completed daily close is
 *     through the opposite 10-day channel for a position of that side, else 0.
 *
 * Fail closed everywhere: a late, gapped, thin or malformed series returns null, the
 * indicator stays absent, and the evaluator never reports an indicator rung as met.
 */

import {
  htfTrendRead,
  htfTrendExitHit,
  type HtfBar,
  type HtfTrendRead,
} from '@/lib/scout/htf-trend-signal-business-logic';
import { HTF_CHANNEL_EXIT_LONG, HTF_CHANNEL_EXIT_SHORT } from './ladder-types';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** No daily read is used this soon after the daily close (00:00 UTC): the venue may still
 *  be settling the bar that just closed. The exit rung and the drafter share this wait. */
export const HTF_SETTLE_MS = 60 * 1000;

/** Bars checked for a gap: every window of the frozen read (20-day channel, ATR20 plus
 *  one prior close) fits inside the newest 22 bars. */
export const HTF_BARS_REQUIRED = 22;

/** Start (00:00 UTC) of the UTC day that contains `ms`. */
export const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** The minimal candle shape this module reads (`timestamp` = the bar OPEN time). */
export interface DailyCandle {
  timestamp: number;
  high: number;
  low: number;
  close: number;
}

export interface CompletedDailySeries {
  /** Completed daily bars, oldest first. The last bar closed at `signalCloseMs`. */
  bars: HtfBar[];
  /** Close time of the newest completed bar (= 00:00 UTC of the current day). */
  signalCloseMs: number;
}

const validBar = (c: DailyCandle): boolean =>
  Number.isFinite(c.timestamp) &&
  [c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0) &&
  c.high >= c.low;

/**
 * The completed daily bars at `now`, or null when the series cannot be trusted:
 *  - the newest completed bar is not yesterday's UTC bar (the feed lags, or `now` is bad);
 *  - fewer than HTF_BARS_REQUIRED completed bars;
 *  - a missing or duplicated day inside the newest HTF_BARS_REQUIRED bars;
 *  - a bar with a non-finite or non-positive price.
 */
export function completedDailySeries(candles: DailyCandle[], now: number): CompletedDailySeries | null {
  if (!Number.isFinite(now) || now <= 0) return null;
  const signalCloseMs = utcDayStart(now);
  const completed = candles
    .filter((c) => Number.isFinite(c.timestamp) && c.timestamp + DAY_MS <= now)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (completed.length < HTF_BARS_REQUIRED) return null;
  if (completed[completed.length - 1].timestamp !== signalCloseMs - DAY_MS) return null;
  const tail = completed.slice(-HTF_BARS_REQUIRED);
  for (let i = 0; i < tail.length; i++) {
    if (!validBar(tail[i])) return null;
    if (i > 0 && tail[i].timestamp - tail[i - 1].timestamp !== DAY_MS) return null;
  }
  // Older bars are outside every window of the frozen read, but a bad one must not
  // reach the read either: keep only the checked tail.
  return {
    bars: tail.map((c) => ({ highPx: c.high, lowPx: c.low, closePx: c.close })),
    signalCloseMs,
  };
}

export interface HtfDailyRead {
  read: HtfTrendRead;
  signalCloseMs: number;
}

/** The frozen htf-trend read on the completed daily bars at `now`, or null (fail closed). */
export function htfDailyRead(candles: DailyCandle[], now: number): HtfDailyRead | null {
  const series = completedDailySeries(candles, now);
  if (!series) return null;
  const read = htfTrendRead(series.bars);
  if (!read) return null;
  return { read, signalCloseMs: series.signalCloseMs };
}

/** The exit indicators for one coin: 1 = the daily close is through the opposite 10-day
 *  channel (the lane's mechanical exit), 0 = it is not. */
export function htfExitIndicators(read: HtfTrendRead): Record<string, number> {
  return {
    [HTF_CHANNEL_EXIT_LONG]: htfTrendExitHit(read, 'long') ? 1 : 0,
    [HTF_CHANNEL_EXIT_SHORT]: htfTrendExitHit(read, 'short') ? 1 : 0,
  };
}
