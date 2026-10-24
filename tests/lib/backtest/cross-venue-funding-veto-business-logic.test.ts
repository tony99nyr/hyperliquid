import { describe, expect, it } from 'vitest';
import { assessFundingVeto, type FundingStudyTrade } from '@/lib/backtest/cross-venue-funding-veto-business-logic';

const DAY = 86_400_000;
const trade = (time: number, side: 'long' | 'short', netR: number): FundingStudyTrade =>
  ({ coin: 'BTC', side, entryTime: time, netR });

describe('cross-venue funding veto', () => {
  it('uses only quotes known before the signal and applies the fixed side threshold', () => {
    const trades = [trade(DAY, 'long', -1), trade(7 * DAY, 'short', -0.5), trade(13 * DAY, 'long', 1)];
    const quotes = [
      { coin: 'BTC', time: DAY - 2 * 3_600_000, binanceTime: DAY - 3 * 3_600_000, hlHourly: 0.00002, binanceEightHour: 0 },
      { coin: 'BTC', time: 7 * DAY - 2 * 3_600_000, binanceTime: 7 * DAY - 3 * 3_600_000, hlHourly: -0.00002, binanceEightHour: 0 },
      { coin: 'BTC', time: 13 * DAY - 2 * 3_600_000, binanceTime: 13 * DAY - 3 * 3_600_000, hlHourly: 0, binanceEightHour: 0 },
      { coin: 'BTC', time: DAY + 1, binanceTime: DAY + 1, hlHourly: 1, binanceEightHour: 0 },
    ];
    const result = assessFundingVeto(trades, quotes);
    expect(result.vetoed.n).toBe(2);
    expect(result.kept.n).toBe(1);
    expect(result.vetoed.meanR).toBe(-0.75);
    expect(result.kept.meanR).toBe(1);
    expect(result.verdict).toBe('insufficient-evidence');
  });

  it('rejects stale quotes without treating missing data as kept', () => {
    const result = assessFundingVeto([trade(DAY, 'long', 1)], [
      { coin: 'BTC', time: DAY - 9 * 3_600_000, binanceTime: DAY - 9 * 3_600_000, hlHourly: 1, binanceEightHour: 0 },
    ]);
    expect(result.unclassified).toBe(1);
    expect(result.kept.n).toBe(0);
  });
});
