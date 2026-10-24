/** Pure descriptive split of closed ladder and scout outcomes by entry regime. */
import { detectMarketRegime, type MarketRegime } from '@/lib/strategy/analysis/market-regime-detector';
import type { PriceCandle } from '@/types/trading-core';

const FOUR_HOURS = 4 * 3_600_000;
const EPISODE = 5 * 86_400_000;
type Regime = MarketRegime | 'unknown';

export interface RegimeOutcome {
  id: string;
  source: 'live-ladder' | 'scout';
  lane: string;
  coin: string;
  entryTime: number;
  netR: number;
}

export interface RegimeCell {
  source: RegimeOutcome['source'];
  lane: string;
  regime: Regime;
  n: number;
  episodes: number;
  totalR: number;
  meanR: number;
  thin: boolean;
  warning: string | null;
}

/** A candle starting at `timestamp` becomes available at its four-hour close. */
export function regimeAtEntry(candles: PriceCandle[], entryTime: number): Regime {
  const available = candles.filter((bar) => bar.timestamp + FOUR_HOURS <= entryTime)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!available.length || entryTime - (available[available.length - 1].timestamp + FOUR_HOURS) > FOUR_HOURS) {
    return 'unknown';
  }
  let first = available.length - 1;
  while (first > 0 && available[first].timestamp - available[first - 1].timestamp === FOUR_HOURS &&
    available.length - first < 199) first--;
  const contiguous = available.slice(first);
  if (contiguous.length < 51) return 'unknown';
  return detectMarketRegime(contiguous, contiguous.length - 1).regime;
}

export function splitRegimeExpectancy(
  outcomes: RegimeOutcome[], candlesByCoin: Record<string, PriceCandle[]>,
): { total: number; unknown: number; cells: RegimeCell[] } {
  const ids = new Set<string>();
  const grouped = new Map<string, { source: RegimeOutcome['source']; lane: string; regime: Regime;
    rs: number[]; episodes: Set<number> }>();
  let unknown = 0;
  for (const row of outcomes) {
    const key = `${row.source}\0${row.id}`;
    if (ids.has(key)) throw new Error(`Duplicate outcome ${key}`);
    ids.add(key);
    if (!Number.isFinite(row.entryTime) || !Number.isFinite(row.netR)) throw new Error(`Invalid outcome ${key}`);
    const regime = regimeAtEntry(candlesByCoin[row.coin.toUpperCase()] ?? [], row.entryTime);
    if (regime === 'unknown') unknown++;
    const cellKey = `${row.source}\0${row.lane}\0${regime}`;
    const cell = grouped.get(cellKey) ?? { source: row.source, lane: row.lane, regime,
      rs: [], episodes: new Set<number>() };
    cell.rs.push(row.netR);
    cell.episodes.add(Math.floor(row.entryTime / EPISODE));
    grouped.set(cellKey, cell);
  }
  const cells = [...grouped.values()].map((cell): RegimeCell => {
    const totalR = cell.rs.reduce((sum, r) => sum + r, 0);
    return { source: cell.source, lane: cell.lane, regime: cell.regime,
      n: cell.rs.length, episodes: cell.episodes.size, totalR,
      meanR: totalR / cell.rs.length, thin: cell.rs.length < 5,
      warning: cell.rs.length < 5 ? 'Fewer than five outcomes; descriptive only.' : null };
  }).sort((a, b) => a.source.localeCompare(b.source) || a.lane.localeCompare(b.lane) ||
    a.regime.localeCompare(b.regime));
  return { total: outcomes.length, unknown, cells };
}
