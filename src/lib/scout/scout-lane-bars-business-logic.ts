/** Resolve the frozen scout lane bars. Pure. */
import manifest from '../../../data/scout/manifest.json';
import bars from '../../../data/scout/lane-bars-v1.0.0.json';
import { DEFAULT_SCORECARD_CONFIG, type ScorecardConfig } from './scout-review-business-logic';

export interface LaneBar {
  registeredAt: string;
  config: ScorecardConfig;
  minExpectancyR: number;
  version: string;
}

export function registeredLaneBar(lane: string): LaneBar | null {
  if (!Object.prototype.hasOwnProperty.call(bars, lane)) return null;
  const entry = bars[lane as keyof typeof bars];
  return {
    registeredAt: entry.registeredAt,
    config: { ...DEFAULT_SCORECARD_CONFIG, monthlyBarUsd: 0, graduationDays: 0, requireDrawdown: false,
      killAfterTrades: entry.killAfterTrades,
      slowBleedDays: entry.slowBleedDays, slowBleedMinTrades: entry.slowBleedMinTrades,
      minTradesToGraduate: entry.minTradesToGraduate },
    minExpectancyR: entry.minExpectancyR,
    version: manifest.active,
  };
}

export function lanePeriodDays(lane: string, now: number, fallbackDays: number): number {
  const bar = registeredLaneBar(lane);
  if (!bar) return fallbackDays;
  return Math.max(1, (now - Date.parse(`${bar.registeredAt}T00:00:00Z`)) / 86_400_000);
}
