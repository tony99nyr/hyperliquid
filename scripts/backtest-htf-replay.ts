/**
 * Read-only htf-trend replay. No credentials, Supabase calls or trading actions.
 *
 * Offline: pnpm exec tsx --tsconfig tsconfig.scripts.json scripts/backtest-htf-replay.ts --fixture path.json
 * Default (no flags): downloads the current HL perp universe itself, paced and cached
 * under data/backups/hyperliquid-study/htf-replay (gitignored). Reruns are cheap and
 * an interrupted run resumes from the cache. Optional: --start, --end, --only BTC,ETH,
 * --listings path.json, --out path.json (default: the cache dir's replay-output.json).
 * A fixture contains { source, inputs: ReplayInput[] }. For synthetic fixtures,
 * an input may use fundingHourly instead of an hourly funding array.
 * A listing manifest contains { source, complete: true, listings: ReplayListing[] }.
 * The manifest must include delisted assets and point-in-time listing dates.
 * Without one, current HL meta supplies an explicitly incomplete proxy universe.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStudyEnv } from './_study-io';
import { discoverTrades, HTF_CACHE, loadFundingWindows, loadUniverse, type UniverseResult } from './_htf-replay-data';
import {
  replayHtfPortfolio, simulateForwardBar, summariseHtfReplay,
  type ReplayBar, type ReplayFunding, type ReplayInput, type ReplayListing,
} from '@/lib/backtest/htf-replay-business-logic';

const DAY = 86_400_000;

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


interface RealExtras {
  excluded: { coin: string; reason: string }[]; delisted: string[]; window: { start: number; end: number };
}

/** Pass 1 finds holding windows, then real funding is fetched for those windows only. */
async function buildInputs(universe: UniverseResult): Promise<{ inputs: ReplayInput[]; excluded: { coin: string; reason: string }[] }> {
  const funding = await loadFundingWindows(discoverTrades(universe));
  const inputs = universe.listings.map((listing): ReplayInput => ({
    coin: listing.coin, listing, bars: universe.bars.get(listing.coin) ?? [], funding: funding.get(listing.coin) ?? [],
  }));
  return { inputs, excluded: [...universe.excluded] };
}

async function main(): Promise<void> {
  const fixturePath = option('fixture');
  let inputs: ReplayInput[];
  let source: string;
  let complete: boolean;
  let realExtras: RealExtras | null = null;
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
    loadStudyEnv();
    const start = dateOption('start', '2022-01-01');
    const end = dateOption('end', new Date(Math.floor(Date.now() / DAY) * DAY).toISOString().slice(0, 10));
    if (end <= start) throw new Error('--end must follow --start');
    const only = option('only')?.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) ?? null;
    const manifest = option('listings');
    let bounds: Map<string, ReplayListing> | null = null;
    if (manifest) {
      const parsed = listingsFromJson(JSON.parse(await readFile(manifest, 'utf8')) as unknown);
      bounds = new Map(parsed.listings.map((l) => [l.coin, l]));
      source = parsed.source;
      complete = parsed.complete;
    } else {
      source = 'current HL meta.universe (delisted perps flagged by HL kept) with listing dates inferred from first candle and first funding row';
      complete = false;
    }
    const universe = await loadUniverse(start, end, only ?? (bounds ? [...bounds.keys()] : null));
    for (const l of universe.listings) {
      const b = bounds?.get(l.coin);
      if (b) { l.from = Math.max(l.from, b.from); l.to = Math.min(l.to, b.to); }
    }
    universe.listings = universe.listings.filter((l) => l.to > l.from);
    const built = await buildInputs(universe);
    inputs = built.inputs;
    realExtras = { excluded: built.excluded, delisted: universe.delisted, window: { start, end } };
  }
  const seed = Number(option('seed') ?? 20261024);
  const iterations = Number(option('iterations') ?? 10_000);
  if (!Number.isInteger(seed) || !Number.isInteger(iterations) || iterations < 1) {
    throw new Error('Seed and iterations must be integers; iterations must be positive');
  }
  if (!inputs.length) throw new Error('No listed coins overlap the requested replay window');
  // Real data: a trade whose holding period lacks an hourly funding row is rejected and counted, never zero-filled.
  const replay = replayHtfPortfolio(inputs, { rejectUncoveredFunding: !fixturePath });
  const registered = replay.trades.filter((t) => ['BTC', 'ETH', 'SOL', 'HYPE'].includes(t.coin));
  const observedEnd = inputs.reduce((max, input) => Math.max(max, input.bars.reduce((m, bar) => Math.max(m, bar.time), 0)), 0);
  const report = {
    status: complete ? 'historical manifest supplied; verify source coverage' : 'INCOMPLETE UNIVERSE PROXY',
    source, seed, iterations, inputCoins: inputs.length, blockedByCap: replay.blockedByCap,
    openAtEnd: replay.openAtEnd, rejectedMissingFunding: replay.rejectedMissingFunding, trades: replay.trades.length,
    coverage: { delistedBeforeObservedEnd: inputs.filter((input) => input.listing.to <= observedEnd).length,
      excludedCoins: realExtras ? realExtras.excluded : [],
      excludedCoinCount: realExtras ? realExtras.excluded.length : 0,
      hlFlaggedDelisted: realExtras ? realExtras.delisted.length : null,
      window: realExtras ? { start: new Date(realExtras.window.start).toISOString().slice(0, 10), end: new Date(realExtras.window.end).toISOString().slice(0, 10) } : null,
      policy: 'a coin with a candle gap or no funding history is excluded and listed; a trade with a funding hole in its holding period is rejected and counted (rejectedMissingFunding); nothing is zero-filled' },
    fullUniverse: replay.trades.length ? summariseHtfReplay(replay.trades, iterations, seed) : null,
    forwardBar: replay.trades.length ? simulateForwardBar(replay.trades, iterations, seed + 1) : null,
    registeredFourCoins: registered.length ? {
      summary: summariseHtfReplay(registered, iterations, seed + 2),
      forwardBar: simulateForwardBar(registered, iterations, seed + 3),
    } : null,
    interpretation: 'Historical prior only. The forward paper record is the sole out-of-sample gate.',
  };
  console.log(JSON.stringify(report, null, 2));
  if (!fixturePath) {
    // Hand-off for study:oi and study:funding-veto.
    const out = option('out') ?? path.join(HTF_CACHE, 'replay-output.json');
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify({ source, status: report.status, generatedAt: new Date().toISOString(),
      blockedByCap: replay.blockedByCap, openAtEnd: replay.openAtEnd,
      rejectedMissingFunding: replay.rejectedMissingFunding, trades: replay.trades }));
    process.stderr.write(`[htf-replay] wrote ${out}\n`);
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
