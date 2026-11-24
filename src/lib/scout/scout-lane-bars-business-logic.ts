/** Resolve the frozen scout lane bars. Pure. */
import manifest from '../../../data/scout/manifest.json';
import barsV100 from '../../../data/scout/lane-bars-v1.0.0.json';
import barsV110 from '../../../data/scout/lane-bars-v1.1.0.json';
import { DEFAULT_SCORECARD_CONFIG, type ScorecardConfig } from './scout-review-business-logic';

export interface LaneBar {
  registeredAt: string;
  config: ScorecardConfig;
  minExpectancyR: number;
  /** Graduation must also hold with the largest entry cluster removed, after the haircut. */
  clusterCheck: { windowDays: number; multiplier: number } | null;
  version: string;
}

// The manifest names the active version. Every version in the manifest is listed here.
const BARS_BY_VERSION: Record<string, typeof barsV100 | typeof barsV110> = { '1.0.0': barsV100, '1.1.0': barsV110 };
const bars = BARS_BY_VERSION[manifest.active];
if (!bars) throw new Error(`scout lane bars: manifest.active ${manifest.active} is not a supported version`);

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
    clusterCheck: 'clusterRobustWindowDays' in entry
      ? { windowDays: entry.clusterRobustWindowDays, multiplier: entry.clusterRobustMultiplier }
      : null,
    version: manifest.active,
  };
}

export function lanePeriodDays(lane: string, now: number, fallbackDays: number): number {
  const bar = registeredLaneBar(lane);
  if (!bar) return fallbackDays;
  return Math.max(1, (now - Date.parse(`${bar.registeredAt}T00:00:00Z`)) / 86_400_000);
}
