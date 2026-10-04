/**
 * Blind-day shadow replay — PURE. Retro 2026-10-03: the scout daemon had multi-day
 * outages ("blind days"), so the lane track records may be missing samples. The
 * heartbeat table is an UPSERT (one row per source, no history), so past outages
 * cannot be read back. This module takes the honest route instead: replay the two
 * mechanical candle lanes over EVERY completed bar in a review window, group the
 * would-have-fired signals into entry EPISODES, and diff them against the actual
 * hypotheses ledger. An episode with no ledger row is a measured miss, whatever the
 * cause (dead daemon, dead consumer, sink failure).
 *
 * The replay reuses the lanes' own frozen rules (`htfTrendRead`, `compressionRead`)
 * on prefix slices of the series, so a replayed signal is exactly what the live scan
 * would have computed on that bar's day.
 *
 * Documented approximations vs the live path:
 *  - EPISODE grouping stands in for the live entry guards. The merge gaps mirror
 *    the frozen per-(lane,coin) entry cooldowns the consumer enforces
 *    (LANE_ENTRY_COOLDOWN_HOURS in scripts/scout-trade.ts: htf-trend 24h,
 *    compression 12h): events within one cooldown merge into one opportunity.
 *    For htf-trend every episode day carries the event, so "awake on any day of
 *    the episode ⇒ entered" holds. For compression the signal is only VISIBLE
 *    while its 4h bar is the latest completed one — a daemon awake only in a gap
 *    bar saw nothing — so a matched episode means "the lane recorded this
 *    opportunity", and the miss count stays an upper bound on daemon-attributable
 *    loss, not an exact outage measure. Squeeze-EPISODE identity ("one entry per
 *    squeeze") is likewise approximated by the cooldown merge, not replayed, and
 *    the merge CHAINS off the previous event: a squeeze re-signalling every
 *    cooldown-length gap folds into one long episode where the live cooldown
 *    would have permitted a later second entry (undercounts opportunities, so it
 *    cannot inflate the miss rate's numerator relative to its denominator).
 *  - The live cycle only scans the top-6 rubric coins at that moment; the replay
 *    scans a fixed coin list. A replayed episode on a coin the rubric had ranked
 *    out that day is counted as missed although the live scout would not have seen
 *    it either — so the miss count reads as "signal the LANE produced", an upper
 *    bound on daemon-attributable loss.
 *  - The scout's concurrency caps (execution guard) and "no position open on the
 *    coin" check are not replayed; a matched episode proves the lane was awake,
 *    not that it traded.
 */

import { htfTrendRead, type HtfTrendConfig } from './htf-trend-signal-business-logic';
import { compressionRead, type CompressionConfig } from './compression-squeeze-signal-business-logic';

export type ShadowLane = 'htf-trend' | 'compression-straddle';

export interface ShadowBar {
  /** Bar OPEN time, epoch ms (HL candle `time`). */
  timeMs: number;
  highPx: number;
  lowPx: number;
  closePx: number;
}

/** One would-have-fired signal on one completed bar. */
export interface ShadowEvent {
  lane: ShadowLane;
  coin: string;
  side: 'long' | 'short';
  barTimeMs: number;
  entryPx: number;
  stopPx: number;
  stopFrac: number;
}

/** A merged entry opportunity (what the live guards would have allowed once). */
export interface ShadowEpisode {
  lane: ShadowLane;
  coin: string;
  /** Side of the FIRST event (a later whipsaw in the same episode is not a second entry). */
  side: 'long' | 'short';
  firstBarMs: number;
  lastBarMs: number;
  events: number;
  entryPx: number;
  stopPx: number;
}

/** A persisted entry from the hypotheses ledger (the lane's actual record). */
export interface ActualEntry {
  lane: string;
  coin: string;
  createdAtMs: number;
}

export interface ShadowDiff {
  matched: Array<{ episode: ShadowEpisode; actualAtMs: number }>;
  missed: ShadowEpisode[];
  /** Ledger rows no replayed episode explains — semantic drift between the replay
   *  and the live path (or an entry on a coin outside the replay list). Report it;
   *  it is a replay-fidelity flag, not sample loss. */
  unexplainedActual: ActualEntry[];
}

const DAY_MS = 86_400_000;
const H4_MS = 4 * 3_600_000;

/** Replay the htf-trend lane: run the frozen daily read on every prefix whose last
 *  completed bar falls inside the window. `bars` must be completed bars only,
 *  ascending, INCLUDING the pre-window lookback (≥ 70 daily bars before the window). */
export function replayHtfTrend(
  bars: ShadowBar[],
  coin: string,
  windowStartMs: number,
  cfg?: HtfTrendConfig,
): ShadowEvent[] {
  const events: ShadowEvent[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].timeMs < windowStartMs) continue;
    const read = htfTrendRead(bars.slice(0, i + 1), cfg);
    if (!read?.breakout) continue;
    const b = read.breakout;
    events.push({ lane: 'htf-trend', coin, side: b.side, barTimeMs: bars[i].timeMs, entryPx: b.entryPx, stopPx: b.stopPx, stopFrac: b.stopFrac });
  }
  return events;
}

/** Replay the compression-straddle lane on completed 4h bars (same contract as above;
 *  needs ≥ ~121 pre-window bars for the BBW percentile history). */
export function replayCompression(
  bars: ShadowBar[],
  coin: string,
  windowStartMs: number,
  cfg?: CompressionConfig,
): ShadowEvent[] {
  const events: ShadowEvent[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].timeMs < windowStartMs) continue;
    const read = compressionRead(bars.slice(0, i + 1), cfg);
    if (!read?.breakout) continue;
    const b = read.breakout;
    events.push({ lane: 'compression-straddle', coin, side: b.side, barTimeMs: bars[i].timeMs, entryPx: b.entryPx, stopPx: b.stopPx, stopFrac: b.stopFrac });
  }
  return events;
}

/** The per-lane bar duration — episode gaps and match windows are measured in it. */
export const LANE_BAR_MS: Record<ShadowLane, number> = {
  'htf-trend': DAY_MS,
  'compression-straddle': H4_MS,
};

/** Events within this many bars of the previous event (same lane+coin, ANY side)
 *  merge into one episode. These MIRROR the consumer's frozen entry cooldowns
 *  (LANE_ENTRY_COOLDOWN_HOURS in scripts/scout-trade.ts: 24h and 12h) — change
 *  them together or the replay stops modelling the live guard. */
export const LANE_MERGE_GAP_BARS: Record<ShadowLane, number> = {
  'htf-trend': 1, // 24h cooldown / 24h bars
  'compression-straddle': 3, // 12h cooldown / 4h bars
};

/** Group per-bar events into entry episodes. Input may be unsorted; grouping is per
 *  (lane, coin), ordered by bar time. */
export function groupEpisodes(events: ShadowEvent[]): ShadowEpisode[] {
  const byKey = new Map<string, ShadowEvent[]>();
  for (const e of events) {
    const k = `${e.lane}|${e.coin.toUpperCase()}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(e);
  }
  const episodes: ShadowEpisode[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.barTimeMs - b.barTimeMs);
    let cur: ShadowEpisode | null = null;
    for (const e of list) {
      const gapMs = LANE_MERGE_GAP_BARS[e.lane] * LANE_BAR_MS[e.lane];
      if (cur && e.barTimeMs - cur.lastBarMs <= gapMs) {
        cur.lastBarMs = e.barTimeMs;
        cur.events++;
      } else {
        if (cur) episodes.push(cur);
        cur = { lane: e.lane, coin: e.coin.toUpperCase(), side: e.side, firstBarMs: e.barTimeMs, lastBarMs: e.barTimeMs, events: 1, entryPx: e.entryPx, stopPx: e.stopPx };
      }
    }
    if (cur) episodes.push(cur);
  }
  return episodes.sort((a, b) => a.firstBarMs - b.firstBarMs);
}

/** The live cycle enters some time AFTER the bar completes (trigger → model latency);
 *  a ledger row within this slack after the episode's last bar still matches. */
export const MATCH_SLACK_MS = 24 * 3_600_000;

/**
 * Diff replayed episodes against the actual hypotheses ledger. An episode matches
 * when a ledger row of the same lane+coin was created between its first bar and
 * (last bar + one bar + slack). Side is deliberately NOT matched: a same-episode
 * row of either side proves the lane was awake, which is the question being asked.
 * Each actual row matches at most one episode (greedy, in time order).
 */
export function diffShadowAgainstActual(episodes: ShadowEpisode[], actual: ActualEntry[], slackMs: number = MATCH_SLACK_MS): ShadowDiff {
  const remaining = [...actual].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const matched: ShadowDiff['matched'] = [];
  const missed: ShadowEpisode[] = [];
  for (const ep of [...episodes].sort((a, b) => a.firstBarMs - b.firstBarMs)) {
    const from = ep.firstBarMs;
    const to = ep.lastBarMs + LANE_BAR_MS[ep.lane] + slackMs;
    const idx = remaining.findIndex(
      (a) => a.lane === ep.lane && a.coin.toUpperCase() === ep.coin && a.createdAtMs >= from && a.createdAtMs <= to,
    );
    if (idx >= 0) {
      matched.push({ episode: ep, actualAtMs: remaining[idx].createdAtMs });
      remaining.splice(idx, 1);
    } else {
      missed.push(ep);
    }
  }
  return { matched, missed, unexplainedActual: remaining };
}

/** The headline number per lane: missed / (missed + matched). NaN-safe (0 when empty). */
export function sampleLossFrac(diff: ShadowDiff, lane: ShadowLane): number {
  const m = diff.matched.filter((x) => x.episode.lane === lane).length;
  const s = diff.missed.filter((x) => x.lane === lane).length;
  const total = m + s;
  return total === 0 ? 0 : s / total;
}
