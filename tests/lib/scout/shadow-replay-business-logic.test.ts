/**
 * Pins the blind-day shadow replay (retro 2026-10-03): the replay must fire exactly
 * where the lanes' own frozen rules fire, group consecutive signals into ONE entry
 * episode (the live entry guards), and classify ledger matches honestly — a wrong
 * replay here feeds false sample-loss numbers into the graduation review.
 */

import { describe, it, expect } from 'vitest';
import {
  replayHtfTrend,
  replayCompression,
  groupEpisodes,
  diffShadowAgainstActual,
  sampleLossFrac,
  MATCH_SLACK_MS,
  type ShadowBar,
  type ShadowEvent,
} from '@/lib/scout/shadow-replay-business-logic';

const DAY = 86_400_000;
const H4 = 4 * 3_600_000;
const T0 = Date.UTC(2026, 6, 1); // 2026-07-01, bar times ascend from here

/** Flat series at `px` with tiny range — never breaks any channel. */
function flatBars(n: number, px: number, barMs: number, t0 = T0): ShadowBar[] {
  return Array.from({ length: n }, (_, i) => ({ timeMs: t0 + i * barMs, highPx: px * 1.001, lowPx: px * 0.999, closePx: px }));
}

describe('replayHtfTrend', () => {
  it('fires on the breakout bar, inside the window only, and not on flat tape', () => {
    // 100 flat daily bars, then 3 bars that close ABOVE the prior 20-day close channel.
    const bars = flatBars(100, 100, DAY);
    for (let i = 0; i < 3; i++) {
      const t = T0 + (100 + i) * DAY;
      const px = 110 + i; // keeps closing above every prior close
      bars.push({ timeMs: t, highPx: px * 1.01, lowPx: px * 0.99, closePx: px });
    }
    const windowStart = T0 + 95 * DAY;
    const events = replayHtfTrend(bars, 'ETH', windowStart);
    expect(events.length).toBe(3); // each successive close still exceeds the prior channel
    expect(events[0]).toMatchObject({ lane: 'htf-trend', coin: 'ETH', side: 'long', barTimeMs: T0 + 100 * DAY });
    expect(events[0].entryPx).toBe(110);
    expect(events[0].stopPx).toBeLessThan(110);
    // Nothing before the window, even though the full series is supplied.
    expect(events.every((e) => e.barTimeMs >= windowStart)).toBe(true);
    // Flat tape alone fires nothing.
    expect(replayHtfTrend(flatBars(120, 100, DAY), 'ETH', T0)).toEqual([]);
  });

  it('fires nothing on a series too thin for the frozen rule (fresh listing)', () => {
    expect(replayHtfTrend(flatBars(10, 100, DAY), 'ETH', T0)).toEqual([]);
  });
});

describe('replayCompression', () => {
  it('fires only when a genuine squeeze resolves through the prior extreme', () => {
    // 180 bars alternating ±2% (wide BBW history), then 40 tightly flat bars (the
    // squeeze), then a close above the prior 20-bar high (the resolving break).
    const bars: ShadowBar[] = [];
    for (let i = 0; i < 180; i++) {
      const px = 100 * (1 + (i % 2 === 0 ? 0.02 : -0.02));
      bars.push({ timeMs: T0 + i * H4, highPx: px * 1.005, lowPx: px * 0.995, closePx: px });
    }
    for (let i = 180; i < 220; i++) bars.push({ timeMs: T0 + i * H4, highPx: 100.2, lowPx: 99.8, closePx: 100 });
    bars.push({ timeMs: T0 + 220 * H4, highPx: 106, lowPx: 100, closePx: 105 });
    const events = replayCompression(bars, 'BTC', T0 + 200 * H4);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1];
    expect(last).toMatchObject({ lane: 'compression-straddle', coin: 'BTC', side: 'long', barTimeMs: T0 + 220 * H4 });
    expect(last.stopFrac).toBeLessThanOrEqual(0.04); // the lane's hard stop cap
  });

  it('fires nothing without the squeeze precondition (wide-vol tape breaking out)', () => {
    const bars: ShadowBar[] = [];
    for (let i = 0; i < 220; i++) {
      const px = 100 * (1 + (i % 2 === 0 ? 0.03 : -0.03));
      bars.push({ timeMs: T0 + i * H4, highPx: px * 1.01, lowPx: px * 0.99, closePx: px });
    }
    bars.push({ timeMs: T0 + 220 * H4, highPx: 120, lowPx: 100, closePx: 118 });
    expect(replayCompression(bars, 'BTC', T0)).toEqual([]);
  });
});

describe('groupEpisodes', () => {
  const ev = (lane: 'htf-trend' | 'compression-straddle', coin: string, barTimeMs: number, side: 'long' | 'short' = 'long'): ShadowEvent => ({
    lane, coin, side, barTimeMs, entryPx: 100, stopPx: 95, stopFrac: 0.05,
  });

  it('merges consecutive htf-trend days into ONE episode; a gap starts a new one', () => {
    const eps = groupEpisodes([
      ev('htf-trend', 'ETH', T0), ev('htf-trend', 'ETH', T0 + DAY), ev('htf-trend', 'ETH', T0 + 2 * DAY),
      ev('htf-trend', 'ETH', T0 + 6 * DAY), // 4-day gap → a fresh opportunity
    ]);
    expect(eps.length).toBe(2);
    expect(eps[0]).toMatchObject({ firstBarMs: T0, lastBarMs: T0 + 2 * DAY, events: 3 });
    expect(eps[1]).toMatchObject({ firstBarMs: T0 + 6 * DAY, events: 1 });
  });

  it('merges a compression whipsaw (opposite sides within the gap) into one episode, keeping the FIRST side', () => {
    const eps = groupEpisodes([ev('compression-straddle', 'BTC', T0, 'long'), ev('compression-straddle', 'BTC', T0 + 2 * H4, 'short')]);
    expect(eps.length).toBe(1);
    expect(eps[0].side).toBe('long'); // the live rule: a stopped-out break is NOT re-entered the other way
  });

  it('pins the merge boundaries at 12h (compression) and 24h (htf-trend)', () => {
    // These literals MIRROR LANE_ENTRY_COOLDOWN_HOURS in scripts/scout-trade.ts
    // (not importable from a script); if the live cooldowns change, change
    // LANE_MERGE_GAP_BARS and this test together.
    // compression: 3 bars (12h) apart merges, 4 bars (16h) splits.
    expect(groupEpisodes([ev('compression-straddle', 'BTC', T0), ev('compression-straddle', 'BTC', T0 + 3 * H4)]).length).toBe(1);
    expect(groupEpisodes([ev('compression-straddle', 'BTC', T0), ev('compression-straddle', 'BTC', T0 + 4 * H4)]).length).toBe(2);
    // htf-trend: 1 day apart merges, 2 days splits (24h cooldown on daily bars).
    expect(groupEpisodes([ev('htf-trend', 'ETH', T0), ev('htf-trend', 'ETH', T0 + DAY)]).length).toBe(1);
    expect(groupEpisodes([ev('htf-trend', 'ETH', T0), ev('htf-trend', 'ETH', T0 + 2 * DAY)]).length).toBe(2);
  });

  it('never merges across coins or lanes', () => {
    const eps = groupEpisodes([ev('htf-trend', 'ETH', T0), ev('htf-trend', 'BTC', T0), ev('compression-straddle', 'ETH', T0)]);
    expect(eps.length).toBe(3);
  });
});

describe('diffShadowAgainstActual', () => {
  const episode = (coin: string, firstBarMs: number, lane: 'htf-trend' | 'compression-straddle' = 'htf-trend') => ({
    lane, coin, side: 'long' as const, firstBarMs, lastBarMs: firstBarMs, events: 1, entryPx: 100, stopPx: 95,
  });

  it('matches a ledger row inside the window (+ one bar + slack), misses outside it', () => {
    const eps = [episode('ETH', T0), episode('BTC', T0)];
    const diff = diffShadowAgainstActual(eps, [
      { lane: 'htf-trend', coin: 'ETH', createdAtMs: T0 + DAY + MATCH_SLACK_MS - 1 }, // just inside
      { lane: 'htf-trend', coin: 'BTC', createdAtMs: T0 + DAY + MATCH_SLACK_MS + 60_000 }, // just outside
    ]);
    expect(diff.matched.length).toBe(1);
    expect(diff.matched[0].episode.coin).toBe('ETH');
    expect(diff.missed.map((e) => e.coin)).toEqual(['BTC']);
    expect(diff.unexplainedActual.map((a) => a.coin)).toEqual(['BTC']);
  });

  it('consumes each ledger row at most once (two episodes cannot share one entry)', () => {
    const eps = [episode('ETH', T0), episode('ETH', T0 + 10 * DAY)];
    const diff = diffShadowAgainstActual(eps, [{ lane: 'htf-trend', coin: 'ETH', createdAtMs: T0 + 3_600_000 }]);
    expect(diff.matched.length).toBe(1);
    expect(diff.missed.length).toBe(1);
  });

  it('a lane/coin mismatch never matches', () => {
    const diff = diffShadowAgainstActual([episode('ETH', T0)], [
      { lane: 'compression-straddle', coin: 'ETH', createdAtMs: T0 },
      { lane: 'htf-trend', coin: 'SOL', createdAtMs: T0 },
    ]);
    expect(diff.matched.length).toBe(0);
    expect(diff.missed.length).toBe(1);
    expect(diff.unexplainedActual.length).toBe(2);
  });

  it('sampleLossFrac: per-lane missed/(missed+matched), 0 when the lane is empty', () => {
    const diff = diffShadowAgainstActual(
      [episode('ETH', T0), episode('BTC', T0), episode('SOL', T0)],
      [{ lane: 'htf-trend', coin: 'ETH', createdAtMs: T0 + 3_600_000 }],
    );
    expect(sampleLossFrac(diff, 'htf-trend')).toBeCloseTo(2 / 3, 10);
    expect(sampleLossFrac(diff, 'compression-straddle')).toBe(0);
  });
});
