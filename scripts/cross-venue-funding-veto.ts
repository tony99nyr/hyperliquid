/**
 * Read-only funding veto study.
 * Default (no flags): takes the trades from pnpm backtest:htf-replay (replay-output.json) and the archived
 * HL predictedFundings observations (hl-observations.json, written by --capture), as preregistered.
 * Archive coverage starts the day capture starts, so the preregistered result is "insufficient" until
 * enough forward observations exist. The run also prints a separate, labelled PROXY from the market_snapshots
 * table (HL funding_hourly, not predictedFundings), which is NOT the preregistered data definition.
 * Other modes: --capture, --fixture FILE, --replay FILE --hl-archive FILE.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStudyEnv, politeFetch, STUDY_CACHE_ROOT, supabaseSelect, cachedJson, parseHlPredictedFundings } from './_study-io';
import { assessFundingVeto, type FundingQuote, type FundingStudyTrade } from '@/lib/backtest/cross-venue-funding-veto-business-logic';
import { replayHtfPortfolio, type ReplayInput } from '@/lib/backtest/htf-replay-business-logic';

const CACHE = path.join(STUDY_CACHE_ROOT, 'cross-venue-funding');
const DEFAULT_REPLAY = path.join(STUDY_CACHE_ROOT, 'htf-replay', 'replay-output.json');
const HOUR = 3_600_000;

function option(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : process.argv[at + 1] ?? null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}

function number(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric value: ${String(value)}`);
  return parsed;
}

function tradesFromFixture(value: unknown): FundingStudyTrade[] {
  const root = record(value);
  if (Array.isArray(root.inputs)) return replayHtfPortfolio(root.inputs as ReplayInput[]).trades;
  if (!Array.isArray(root.trades)) throw new Error('Replay JSON needs inputs or trades');
  return root.trades.map((raw) => {
    const row = record(raw);
    if (typeof row.coin !== 'string' || (row.side !== 'long' && row.side !== 'short')) {
      throw new Error('Invalid replay trade');
    }
    return { coin: row.coin, side: row.side, entryTime: number(row.entryTime), netR: number(row.netR) };
  });
}

interface HlObservation { coin: string; time: number; hlHourly: number }
function observations(value: unknown): HlObservation[] {
  if (!Array.isArray(value)) throw new Error('HL archive must be an array of {coin,time,hlHourly}');
  return value.map((raw) => {
    const row = record(raw);
    if (typeof row.coin !== 'string') throw new Error('HL archive coin missing');
    return { coin: row.coin.toUpperCase(), time: number(row.time), hlHourly: number(row.hlHourly) };
  });
}

async function captureForwardQuotes(): Promise<void> {
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'predictedFundings' }),
  });
  if (!response.ok) throw new Error(`HL predictedFundings failed: ${response.status}`);
  const current = parseHlPredictedFundings(await response.json() as unknown, Date.now());
  const time = current[0]?.time ?? Date.now();
  if (!current.length) throw new Error('No HlPerp funding rows in predictedFundings response');
  await mkdir(CACHE, { recursive: true });
  const file = path.join(CACHE, 'hl-observations.json');
  let previous: HlObservation[] = [];
  try { previous = observations(JSON.parse(await readFile(file, 'utf8')) as unknown); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(file, JSON.stringify([...previous, ...current]));
  console.log(JSON.stringify({ capturedAt: time, coins: current.length, archive: file }, null, 2));
}

function months(start: number, end: number): string[] {
  const result: string[] = [];
  const cursor = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth()));
  while (cursor.getTime() <= end) {
    result.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return result;
}

/** HL k-prefixed coins (kPEPE) trade as 1000PEPE on Binance. */
function binanceSymbol(coin: string): string {
  return /^k[A-Z]/.test(coin) ? `1000${coin.slice(1)}USDT` : `${coin}USDT`;
}

async function binanceRates(coin: string, start: number, end: number): Promise<{ time: number; rate: number }[]> {
  const rows: { time: number; rate: number }[] = [];
  await mkdir(CACHE, { recursive: true });
  for (const month of months(start, end)) {
    const symbol = binanceSymbol(coin);
    const name = `${symbol}-fundingRate-${month}.zip`;
    const file = path.join(CACHE, name);
    try { await readFile(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const url = `https://data.binance.vision/data/futures/um/monthly/fundingRate/${symbol}/${name}`;
      const response = await politeFetch(url, {}, { label: `Binance archive ${name}`, retries: 3 });
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
    }
    const csv = execFileSync('unzip', ['-p', file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const lines = csv.trim().split(/\r?\n/);
    const header = lines.shift()?.split(',') ?? [];
    const timeAt = header.findIndex((x) => /^(fundingTime|calc_time)$/i.test(x.trim()));
    const rateAt = header.findIndex((x) => /^(fundingRate|last_funding_rate)$/i.test(x.trim()));
    if (timeAt < 0 || rateAt < 0) throw new Error(`Unknown Binance funding header: ${header.join(',')}`);
    for (const line of lines) {
      const cells = line.split(',');
      const time = Number(cells[timeAt]);
      const rate = Number(cells[rateAt]);
      if (Number.isFinite(time) && Number.isFinite(rate)) rows.push({ time, rate });
    }
  }
  rows.sort((a, b) => a.time - b.time);
  return rows.slice(1).flatMap((row, index) => {
    const intervalHours = (row.time - rows[index].time) / HOUR;
    return intervalHours > 0 && intervalHours <= 8 && Number.isInteger(intervalHours)
      ? [{ time: row.time, rate: row.rate * 8 / intervalHours }] : [];
  });
}

async function main(): Promise<void> {
  if (process.argv.includes('--capture')) { await captureForwardQuotes(); return; }
  const fixture = option('fixture');
  if (fixture) {
    const data = record(JSON.parse(await readFile(fixture, 'utf8')) as unknown);
    const trades = tradesFromFixture(data);
    if (!Array.isArray(data.quotes)) throw new Error('Fixture needs quotes');
    console.log(JSON.stringify(assessFundingVeto(trades, data.quotes as FundingQuote[]), null, 2));
    return;
  }
  const replayPath = option('replay') ?? DEFAULT_REPLAY;
  const archivePath = option('hl-archive') ?? path.join(CACHE, 'hl-observations.json');
  let replayJson: unknown;
  try { replayJson = JSON.parse(await readFile(replayPath, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No replay output at ${replayPath}. Run pnpm backtest:htf-replay first.`);
    throw error;
  }
  const trades = tradesFromFixture(replayJson);
  let archived: HlObservation[] = [];
  try { archived = observations(JSON.parse(await readFile(archivePath, 'utf8')) as unknown); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const registered = await quotesFor(archived, new Set());
  const preregistered = {
    source: 'HL timestamped predictedFundings archive plus Binance Vision',
    archivedObservations: archived.length,
    archiveFirstCapture: archived.length ? new Date(Math.min(...archived.map((o) => o.time))).toISOString() : null,
    tradesAfterFirstCapture: archived.length ? trades.filter((t) => t.entryTime >= Math.min(...archived.map((o) => o.time))).length : 0,
    forwardCaptureNeeded: archived.length === 0
      ? 'No archive yet. Run pnpm study:funding-veto -- --capture at least once every 8 hours (ideally 23:55 UTC daily, before each daily signal close) and rerun later.'
      : 'Keep capturing until each of vetoed and kept has 5 or more independent entry episodes.',
    ...assessFundingVeto(trades, registered.quotes),
    binanceUnavailable: registered.unavailable,
  };
  let proxy: unknown = null;
  if (!option('hl-archive') && !option('replay')) {
    loadStudyEnv();
    proxy = await proxyFromSnapshots(trades);
  }
  console.log(JSON.stringify({ preregistered, proxy }, null, 2));
}

async function quotesFor(archived: HlObservation[], skip: Set<string>): Promise<{ quotes: FundingQuote[]; unavailable: string[] }> {
  const quotes: FundingQuote[] = [];
  const unavailable: string[] = [];
  for (const coin of [...new Set(archived.map((row) => row.coin))]) {
    if (skip.has(coin)) continue;
    const coinRows = archived.filter((row) => row.coin === coin);
    let rates: { time: number; rate: number }[];
    try {
      rates = await binanceRates(coin, Math.min(...coinRows.map((row) => row.time)) - HOUR * 8, Math.max(...coinRows.map((row) => row.time)));
    } catch (error) {
      unavailable.push(`${coin}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const row of coinRows) {
      const last = rates.filter((rate) => rate.time <= row.time && row.time - rate.time <= HOUR * 8).at(-1);
      if (last) quotes.push({ ...row, binanceTime: last.time, binanceEightHour: last.rate });
    }
  }
  return { quotes, unavailable };
}

/** PROXY, not the preregistered data: HL funding_hourly from market_snapshots (select-only, per-trade 8h windows). */
async function proxyFromSnapshots(trades: FundingStudyTrade[]): Promise<unknown> {
  const first = (await supabaseSelect('market_snapshots', 'captured_at', {}, 'captured_at.asc', 1))[0];
  const since = Date.parse(String(first?.captured_at));
  if (!Number.isFinite(since)) return { note: 'market_snapshots is empty' };
  const inRange = trades.filter((t) => t.entryTime >= since);
  const observed: HlObservation[] = [];
  for (const trade of inRange) {
    const lo = trade.entryTime - 8 * HOUR;
    const rows = await cachedJson(path.join(CACHE, 'proxy'), `${trade.coin}-${lo}.json`, () => supabaseSelect(
      'market_snapshots', 'coin,captured_at,funding_hourly', {
        coin: `eq.${trade.coin}`, and: `(captured_at.gte.${new Date(lo).toISOString()},captured_at.lte.${new Date(trade.entryTime).toISOString()})`,
      }, 'captured_at.asc', 500));
    for (const row of rows) {
      const hl = Number(row.funding_hourly);
      const time = Date.parse(String(row.captured_at));
      if (Number.isFinite(hl) && Number.isFinite(time) && row.funding_hourly !== null) observed.push({ coin: trade.coin, time, hlHourly: hl });
    }
  }
  const unique = [...new Map(observed.map((o) => [`${o.coin}-${o.time}`, o])).values()];
  const built = await quotesFor(unique, new Set());
  return {
    label: 'PROXY ONLY. HL funding_hourly from market_snapshots, not archived predictedFundings. Not the preregistered data definition.',
    marketSnapshotsEarliest: new Date(since).toISOString(),
    tradesBeforeSnapshotHistory: trades.length - inRange.length,
    snapshotObservations: unique.length,
    binanceUnavailable: built.unavailable,
    ...assessFundingVeto(trades, built.quotes),
  };
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
