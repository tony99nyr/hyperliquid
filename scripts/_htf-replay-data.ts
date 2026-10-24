/**
 * I/O for the htf replay: paced, cached, resumable download of daily bars and
 * the hourly funding that the replay's trades actually hold through.
 * Read-only: HL info queries only. Every download is cached under the
 * gitignored data/backups/hyperliquid-study/htf-replay/ directory.
 *
 * Funding is fetched lazily. Signals and fills depend on bars only, so a first
 * pass with zero placeholder funding finds each trade's holding window, then
 * only those windows are downloaded. The final replay uses real funding, and
 * the placeholder never reaches a reported number.
 */
import path from 'node:path';
import { cachedJson, hlCandles, hlFirstFunding, hlFundingHistory, hlInfo, STUDY_CACHE_ROOT, type HourlyFunding } from './_study-io';
import {
  replayHtfPortfolio, type ReplayBar, type ReplayFunding, type ReplayInput, type ReplayListing, type ReplayTrade,
} from '@/lib/backtest/htf-replay-business-logic';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const HTF_CACHE = path.join(STUDY_CACHE_ROOT, 'htf-replay');
const MERGE_GAP = 5 * DAY;

export interface UniverseCoin { name: string; delisted: boolean }
export interface UniverseResult {
  listings: ReplayListing[];
  bars: Map<string, ReplayBar[]>;
  firstFunding: Map<string, number>;
  excluded: { coin: string; reason: string }[];
  delisted: string[];
}

/** Snap HL's jittered funding timestamps to their nominal hour. PURE. */
export function snapFunding(points: HourlyFunding[]): ReplayFunding[] {
  const byHour = new Map<number, number>();
  for (const p of points) byHour.set(Math.round(p.time / HOUR) * HOUR, p.fundingHourly);
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([time, fundingHourly]) => ({ time, fundingHourly }));
}

/** Longest check: index of the first gap in a daily series, or -1. PURE. */
export function firstDailyGap(bars: ReplayBar[]): number {
  for (let i = 1; i < bars.length; i++) if (bars[i].time - bars[i - 1].time !== DAY) return i;
  return -1;
}

/** Merge [start,end] windows that sit within `gap` of each other. PURE. */
export function mergeWindows(windows: [number, number][], gap = MERGE_GAP): [number, number][] {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start - last[1] <= gap) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function log(message: string): void { process.stderr.write(`[htf-replay] ${message}\n`); }

export async function loadUniverse(start: number, end: number, only: string[] | null): Promise<UniverseResult> {
  const meta = await cachedJson(HTF_CACHE, 'v2-meta.json', async () => {
    const raw = await hlInfo<{ universe?: Array<{ name: string; isDelisted?: boolean }> }>({ type: 'meta' });
    return (raw.universe ?? []).map((a): UniverseCoin => ({ name: a.name, delisted: a.isDelisted === true }));
  }, 6 * HOUR);
  const wanted = only?.map((x) => x.toUpperCase());
  const coins = wanted ? meta.filter((c) => wanted.includes(c.name.toUpperCase())) : meta;
  log(`universe: ${coins.length} perps from HL meta (${coins.filter((c) => c.delisted).length} flagged delisted)`);
  const result: UniverseResult = { listings: [], bars: new Map(), firstFunding: new Map(), excluded: [],
    delisted: coins.filter((c) => c.delisted).map((c) => c.name) };
  let done = 0;
  for (const coin of coins) {
    done++;
    if (process.env.STUDY_VERBOSE) log(`coin ${coin.name}`);
    try {
      const rows = await cachedJson(HTF_CACHE, `v2-bars-${coin.name}-${start}-${end}.json`, async () => {
        const candles = await hlCandles(coin.name, '1d', start - 25 * DAY, end);
        return candles.map((b): ReplayBar => ({ time: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close }));
      });
      const first = await cachedJson(HTF_CACHE, `v2-firstfunding-${coin.name}.json`, async () => {
        return hlFirstFunding(coin.name);
      });
      const bars = rows.filter((b) => b.time < end);
      if (!bars.length) { result.excluded.push({ coin: coin.name, reason: 'no daily candles' }); continue; }
      if (first === null) { result.excluded.push({ coin: coin.name, reason: 'no funding history' }); continue; }
      const gap = firstDailyGap(bars);
      if (gap >= 0) { result.excluded.push({ coin: coin.name, reason: `daily candle gap at ${new Date(bars[gap].time).toISOString().slice(0, 10)}` }); continue; }
      // Funding must cover every holding hour, so the tradable window starts at the first full funding day.
      const from = Math.max(bars[0].time, Math.ceil(first / DAY) * DAY);
      const lastBar = bars[bars.length - 1].time;
      const to = coin.delisted && lastBar + DAY < end ? lastBar + DAY : end;
      if (to <= from) { result.excluded.push({ coin: coin.name, reason: 'window empty after funding start' }); continue; }
      result.listings.push({ coin: coin.name, from, to });
      result.bars.set(coin.name, bars);
      result.firstFunding.set(coin.name, first);
    } catch (error) {
      result.excluded.push({ coin: coin.name, reason: `fetch failed: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (done % 10 === 0 || done === coins.length) log(`bars ${done}/${coins.length} (${result.listings.length} usable, ${result.excluded.length} excluded)`);
  }
  return result;
}

/** Pass 1: find every trade with placeholder funding. Placeholder values never leave this function. */
export function discoverTrades(universe: UniverseResult): ReplayTrade[] {
  const inputs: ReplayInput[] = universe.listings.map((listing) => {
    const funding: ReplayFunding[] = [];
    for (let t = listing.from; t <= listing.to + DAY; t += HOUR) funding.push({ time: t, fundingHourly: 0 });
    return { coin: listing.coin, listing, bars: universe.bars.get(listing.coin) ?? [], funding };
  });
  return replayHtfPortfolio(inputs).trades;
}

export async function loadFundingWindows(trades: ReplayTrade[]): Promise<Map<string, ReplayFunding[]>> {
  const byCoin = new Map<string, [number, number][]>();
  for (const t of trades) byCoin.set(t.coin, [...(byCoin.get(t.coin) ?? []), [t.entryTime, t.exitTime]]);
  const result = new Map<string, ReplayFunding[]>();
  let n = 0;
  for (const [coin, windows] of [...byCoin.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const series: ReplayFunding[] = [];
    for (const [from, to] of mergeWindows(windows)) {
      const raw = await cachedJson(HTF_CACHE, `v2-funding-${coin}-${from}-${to}.json`,
        () => hlFundingHistory(coin, from - HOUR, to + HOUR));
      series.push(...snapFunding(raw));
    }
    result.set(coin, [...new Map(series.map((p) => [p.time, p])).values()].sort((a, b) => a.time - b.time));
    n++;
    if (n % 5 === 0 || n === byCoin.size) log(`funding ${n}/${byCoin.size} coins`);
  }
  return result;
}
