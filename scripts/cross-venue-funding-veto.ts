/** Read-only funding veto study. Capture forward quotes before replay analysis. */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assessFundingVeto, type FundingQuote, type FundingStudyTrade } from '@/lib/backtest/cross-venue-funding-veto-business-logic';
import { replayHtfPortfolio, type ReplayInput } from '@/lib/backtest/htf-replay-business-logic';

const CACHE = path.resolve('data/backups/hyperliquid-study/cross-venue-funding');
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
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error('Unexpected predictedFundings response');
  const time = Date.now();
  const current: HlObservation[] = [];
  for (const item of payload) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || !Array.isArray(item[1])) continue;
    const hl = item[1].map(record).find((row) => row.venue === 'HlPerp');
    if (!hl) continue;
    const interval = number(hl.fundingIntervalHours);
    if (interval <= 0) throw new Error('Invalid HL funding interval');
    current.push({ coin: item[0].toUpperCase(), time,
      hlHourly: number(hl.fundingRate) / interval });
  }
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

async function binanceRates(coin: string, start: number, end: number): Promise<{ time: number; rate: number }[]> {
  const rows: { time: number; rate: number }[] = [];
  await mkdir(CACHE, { recursive: true });
  for (const month of months(start, end)) {
    const name = `${coin}USDT-fundingRate-${month}.zip`;
    const file = path.join(CACHE, name);
    try { await readFile(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const url = `https://data.binance.vision/data/futures/um/monthly/fundingRate/${coin}USDT/${name}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Binance archive ${response.status}: ${url}`);
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
  const replayPath = option('replay');
  const archivePath = option('hl-archive');
  if (!replayPath || !archivePath) throw new Error('Use --fixture FILE, --capture, or --replay FILE --hl-archive FILE');
  const trades = tradesFromFixture(JSON.parse(await readFile(replayPath, 'utf8')) as unknown);
  const archived = observations(JSON.parse(await readFile(archivePath, 'utf8')) as unknown);
  const quotes: FundingQuote[] = [];
  for (const coin of [...new Set(archived.map((row) => row.coin))]) {
    const coinRows = archived.filter((row) => row.coin === coin);
    const rates = await binanceRates(coin, Math.min(...coinRows.map((row) => row.time)) - HOUR * 8,
      Math.max(...coinRows.map((row) => row.time)));
    for (const row of coinRows) {
      const last = rates.filter((rate) => rate.time <= row.time && row.time - rate.time <= HOUR * 8).at(-1);
      if (last) quotes.push({ ...row, binanceTime: last.time, binanceEightHour: last.rate });
    }
  }
  console.log(JSON.stringify({ source: 'HL timestamped predictedFundings archive plus Binance Vision',
    ...assessFundingVeto(trades, quotes) }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
