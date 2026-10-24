import { describe, expect, it } from 'vitest';
import {
  replayHtfPortfolio, summariseHtfReplay, simulateForwardBar, forwardBarPass,
  type ReplayBar, type ReplayInput,
} from '@/lib/backtest/htf-replay-business-logic';

const DAY = 86_400_000;
const start = Date.UTC(2025, 0, 1);

function series(coin: string, signalClose = 105, entryOpen = 110): ReplayInput {
  const bars: ReplayBar[] = Array.from({ length: 23 }, (_, i) => ({
    time: start + i * DAY, open: 100, high: 102, low: 98, close: 100,
  }));
  bars.push({ time: start + 23 * DAY, open: 100, high: 107, low: 99, close: signalClose });
  bars.push({ time: start + 24 * DAY, open: entryOpen, high: 111, low: 108, close: 110 });
  bars.push({ time: start + 25 * DAY, open: 110, high: 111, low: 80, close: 90 });
  return { coin, listing: { coin, from: start, to: start + 26 * DAY }, bars,
    funding: Array.from({ length: 27 * 24 }, (_, i) => ({ time: start + i * 3_600_000, fundingHourly: 0 })) };
}

describe('htf replay funding coverage', () => {
  it('throws on a funding hole by default and rejects only that trade when asked', () => {
    const input = series('BTC');
    input.funding = input.funding.filter((p) => p.time !== start + 24 * DAY + 5 * 3_600_000);
    expect(() => replayHtfPortfolio([input])).toThrow(/Missing hourly funding/);
    const result = replayHtfPortfolio([input], { rejectUncoveredFunding: true });
    expect(result.trades).toHaveLength(0);
    expect(result.rejectedMissingFunding).toBe(1);
    expect(replayHtfPortfolio([series('BTC')], { rejectUncoveredFunding: true }).rejectedMissingFunding).toBe(0);
  });
});

describe('htf replay', () => {
  it('lags a completed breakout by one bar and uses the next open', () => {
    const result = replayHtfPortfolio([series('BTC')]);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryTime).toBe(start + 24 * DAY);
    expect(result.trades[0].entryPx).toBeCloseTo(110 * 1.0016);
  });

  it('enforces two same-direction majors on the shared clock', () => {
    const result = replayHtfPortfolio(['BTC', 'ETH', 'SOL'].map((coin) => series(coin)));
    expect(result.trades.map((t) => t.coin)).toEqual(['BTC', 'ETH']);
    expect(result.blockedByCap).toBe(2);
  });

  it('charges both adverse fills, both taker fees and historical funding', () => {
    const input = series('BTC');
    input.funding = input.funding.map((p) => ({ ...p, fundingHourly: 0.001 }));
    const trade = replayHtfPortfolio([input]).trades[0];
    const exitPx = trade.stopPx * 0.9984;
    const risk = trade.entryPx - trade.stopPx;
    const fundingHours = 48;
    const expected = (exitPx - trade.entryPx - 0.00045 * (trade.entryPx + exitPx)
      - fundingHours * 0.001 * trade.entryPx) / risk;
    expect(trade.netR).toBeCloseTo(expected, 8);
  });

  it('attributes a cross-year close to the entry-year fold', () => {
    const input = series('BTC');
    const shift = Date.UTC(2025, 11, 7) - start;
    input.bars = input.bars.map((bar) => ({ ...bar, time: bar.time + shift }));
    input.funding = input.funding.map((p) => ({ ...p, time: p.time + shift }));
    input.listing = { coin: 'BTC', from: start + shift, to: start + shift + 26 * DAY };
    const result = replayHtfPortfolio([input]);
    expect(result.trades[0].entryTime).toBeLessThan(Date.UTC(2026, 0, 1));
    expect(result.trades[0].exitTime).toBeGreaterThan(Date.UTC(2026, 0, 1));
    expect(summariseHtfReplay(result.trades, 100, 7).folds.map((fold) => fold.year)).toEqual([2025]);
  });

  it('repeats the episode bootstrap and complete forward-bar simulation with a seed', () => {
    const trades = replayHtfPortfolio(['BTC', 'ETH'].map((coin) => series(coin))).trades;
    expect(summariseHtfReplay(trades, 100, 71)).toEqual(summariseHtfReplay(trades, 100, 71));
    expect(simulateForwardBar(trades, 100, 71)).toEqual(simulateForwardBar(trades, 100, 71));
  });

  it('checks the complete forward bar after removing the strongest five-day cluster', () => {
    const sample = Array.from({ length: 20 }, (_, i) => ({
      time: start + i * 6 * DAY, r: i === 0 ? 8 : 0.1,
    }));
    expect(sample.reduce((sum, x) => sum + x.r, 0) / 20).toBeGreaterThan(0.25);
    expect(forwardBarPass(sample)).toBe(false);
    expect(forwardBarPass(sample.map((x) => ({ ...x, r: 0.3 })))).toBe(true);
  });
});
