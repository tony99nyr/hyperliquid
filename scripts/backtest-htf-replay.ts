/**
 * Read-only htf-trend replay. No credentials, Supabase calls or trading actions.
 *
 * Offline: pnpm exec tsx --tsconfig tsconfig.scripts.json scripts/backtest-htf-replay.ts --fixture path.json
 * Online:  pnpm exec tsx --tsconfig tsconfig.scripts.json scripts/backtest-htf-replay.ts --listings path.json
 * A fixture contains { source, inputs: ReplayInput[] }. For synthetic fixtures,
 * an input may use fundingHourly instead of an hourly funding array.
 * A listing manifest contains { source, complete: true, listings: ReplayListing[] }.
 * The manifest must include delisted assets and point-in-time listing dates.
 * Without one, current HL meta supplies an explicitly incomplete proxy universe.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchCandles, fetchFundingHistory } from '@/lib/hyperliquid/candle-service';
import { fetchPerpMeta } from '@/lib/hyperliquid/hyperliquid-info-service';
import {
  replayHtfPortfolio, simulateForwardBar, summariseHtfReplay,
  type ReplayBar, type ReplayFunding, type ReplayInput, type ReplayListing,
} from '@/lib/backtest/htf-replay-business-logic';

const DAY = 86_400_000;
const CACHE = path.resolve('data/backups/hyperliquid-study/htf-replay');

function option(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : process.argv[at + 1] ?? null;
}

function dateOption(name: string, fallback: string): number {
  const value = Date.parse(option(name) ?? fallback);
  if (!Number.isFinite(value) || value % DAY !== 0) throw new Error(`--${name} needs a UTC date`);
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}

function listingsFromJson(value: unknown): { source: string; complete: boolean; listings: ReplayListing[] } {
  const root = object(value);
  if (typeof root.source !== 'string' || root.complete !== true || !Array.isArray(root.listings)) {
    throw new Error('Historical listing manifest needs source, complete: true and listings');
  }
  const listings = root.listings.map((raw): ReplayListing => {
    const item = object(raw);
    const from = typeof item.from === 'string' ? Date.parse(item.from) : item.from;
    const to = typeof item.to === 'string' ? Date.parse(item.to) : item.to;
    if (typeof item.coin !== 'string' || typeof from !== 'number' || typeof to !== 'number' ||
      !Number.isFinite(from) || !Number.isFinite(to) || from % DAY !== 0 || to % DAY !== 0 || to <= from) {
      throw new Error('Invalid listing row. Use UTC day boundaries and exclusive to.');
    }
    return { coin: item.coin.toUpperCase(), from, to };
  });
  if (!listings.length || new Set(listings.map((x) => x.coin)).size !== listings.length) {
    throw new Error('Listing manifest is empty or repeats a coin');
  }
  return { source: root.source, complete: true, listings };
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  await mkdir(CACHE, { recursive: true });
  const file = path.join(CACHE, key);
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const result = await load();
  await writeFile(file, JSON.stringify(result));
  return result;
}

async function fetchInput(listing: ReplayListing, start: number, end: number): Promise<ReplayInput> {
  const from = Math.max(start - 25 * DAY, listing.from);
  const to = Math.min(end, listing.to);
  const key = `${listing.coin}-${from}-${to}`;
  return cached(`${key}.json`, async () => {
    const response = await fetchCandles(listing.coin, '1d', from, to);
    if (response.stale || response.error || !response.candles.length) {
      throw new Error(`Candle fetch failed for ${listing.coin}: ${response.error ?? 'empty or stale'}`);
    }
    const bars: ReplayBar[] = response.candles.map((bar) => ({
      time: bar.timestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    }));
    const funding: ReplayFunding[] = [];
    // Existing funding service caps a call near 625 days. Chunk with overlap avoided.
    for (let cursor = from; cursor < to; cursor += 400 * DAY) {
      const stop = Math.min(cursor + 400 * DAY, to);
      funding.push(...await fetchFundingHistory(listing.coin, cursor, stop));
    }
    const unique = [...new Map(funding.map((p) => [p.time, p])).values()].sort((a, b) => a.time - b.time);
    return { coin: listing.coin, listing, bars, funding: unique };
  });
}

async function main(): Promise<void> {
  const fixturePath = option('fixture');
  let inputs: ReplayInput[];
  let source: string;
  let complete: boolean;
  if (fixturePath) {
    const fixture = object(JSON.parse(await readFile(fixturePath, 'utf8')) as unknown);
    if (!Array.isArray(fixture.inputs) || typeof fixture.source !== 'string') {
      throw new Error('Fixture needs source and inputs');
    }
    inputs = fixture.inputs.map((raw): ReplayInput => {
      const row = object(raw);
      if (typeof row.fundingHourly !== 'number') return row as unknown as ReplayInput;
      if (!Array.isArray(row.bars) || !row.bars.length) throw new Error('Synthetic fixture needs bars');
      const bars = row.bars as ReplayBar[];
      const from = bars[0].time;
      const to = bars[bars.length - 1].time + DAY;
      const funding: ReplayFunding[] = [];
      for (let time = from; time <= to; time += 3_600_000) {
        funding.push({ time, fundingHourly: row.fundingHourly });
      }
      return { coin: row.coin as string, listing: row.listing as ReplayListing, bars, funding };
    });
    source = fixture.source;
    complete = fixture.complete === true;
  } else {
    const start = dateOption('start', '2022-01-01');
    const end = dateOption('end', '2026-10-24');
    if (end <= start) throw new Error('--end must follow --start');
    const manifest = option('listings');
    let listings: ReplayListing[];
    if (manifest) {
      const parsed = listingsFromJson(JSON.parse(await readFile(manifest, 'utf8')) as unknown);
      listings = parsed.listings;
      source = parsed.source;
      complete = parsed.complete;
    } else {
      const meta = await fetchPerpMeta('mainnet');
      listings = meta.map((asset) => ({ coin: asset.name, from: start, to: end }));
      source = 'current HL meta.universe proxy; excludes delisted perps and true listing dates';
      complete = false;
    }
    inputs = [];
    for (const listing of listings) {
      if (listing.to <= start || listing.from >= end) continue;
      inputs.push(await fetchInput(listing, start, end));
    }
  }
  const seed = Number(option('seed') ?? 20261024);
  const iterations = Number(option('iterations') ?? 10_000);
  if (!Number.isInteger(seed) || !Number.isInteger(iterations) || iterations < 1) {
    throw new Error('Seed and iterations must be integers; iterations must be positive');
  }
  if (!inputs.length) throw new Error('No listed coins overlap the requested replay window');
  const replay = replayHtfPortfolio(inputs);
  const registered = replay.trades.filter((t) => ['BTC', 'ETH', 'SOL', 'HYPE'].includes(t.coin));
  const observedEnd = Math.max(...inputs.flatMap((input) => input.bars.map((bar) => bar.time)));
  const report = {
    status: complete ? 'historical manifest supplied; verify source coverage' : 'INCOMPLETE UNIVERSE PROXY',
    source, seed, iterations, inputCoins: inputs.length, blockedByCap: replay.blockedByCap,
    openAtEnd: replay.openAtEnd, trades: replay.trades.length,
    coverage: { delistedBeforeObservedEnd: inputs.filter((input) => input.listing.to <= observedEnd).length,
      missingDailyBars: 0, missingHoldingPeriodFundingHours: 0,
      policy: 'fail the replay on a candle gap or missing holding-period funding' },
    fullUniverse: replay.trades.length ? summariseHtfReplay(replay.trades, iterations, seed) : null,
    forwardBar: replay.trades.length ? simulateForwardBar(replay.trades, iterations, seed + 1) : null,
    registeredFourCoins: registered.length ? {
      summary: summariseHtfReplay(registered, iterations, seed + 2),
      forwardBar: simulateForwardBar(registered, iterations, seed + 3),
    } : null,
    interpretation: 'Historical prior only. The forward paper record is the sole out-of-sample gate.',
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
