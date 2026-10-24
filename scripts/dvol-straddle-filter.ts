/**
 * Read-only DVOL straddle study. Default (no flags): reads filled live event-straddle
 * outcomes from Supabase (SELECT only) and pulls Deribit public DVOL and daily closes.
 * Offline: --fixture FILE or --outcomes FILE.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStudyEnv, politeFetch, sleep } from './_study-io';
import { loadStraddleLegs } from './_straddle-legs';
import {
  evaluateDvolStraddles,
  type DailyClose,
  type DvolObservation,
  type StraddleLeg,
  type VolatilityHistory,
} from '@/lib/backtest/dvol-straddle-filter-business-logic';

const DAY_MS = 86_400_000;
const CACHE_DIR = path.resolve('data/backups/hyperliquid-study/dvol-straddle-filter');

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function legsFrom(value: unknown): StraddleLeg[] {
  if (!Array.isArray(value)) throw new Error('Outcomes must be a JSON array');
  return value.map((item, index) => {
    const row = object(item);
    if (!row || typeof row.eventId !== 'string' || (row.coin !== 'BTC' && row.coin !== 'ETH') ||
      typeof row.printAtMs !== 'number' || typeof row.netR !== 'number' || typeof row.riskUsd !== 'number' ||
      !Number.isFinite(row.printAtMs) || !Number.isFinite(row.netR) || !Number.isFinite(row.riskUsd) || row.riskUsd <= 0) {
      throw new Error(`Invalid outcome at index ${index}; need eventId, BTC/ETH coin, printAtMs, slip-aware netR, riskUsd`);
    }
    return { eventId: row.eventId, coin: row.coin, printAtMs: row.printAtMs, netR: row.netR, riskUsd: row.riskUsd };
  });
}

function historyFrom(value: unknown): Partial<Record<'BTC' | 'ETH', VolatilityHistory>> {
  const root = object(value);
  if (!root) throw new Error('Fixture history must be an object');
  const result: Partial<Record<'BTC' | 'ETH', VolatilityHistory>> = {};
  for (const coin of ['BTC', 'ETH'] as const) {
    const entry = object(root[coin]);
    if (!entry) continue;
    if (!Array.isArray(entry.closes) || !Array.isArray(entry.dvol)) throw new Error(`Invalid ${coin} fixture history`);
    const closes: DailyClose[] = entry.closes.map((item: unknown) => {
      const row = object(item);
      if (!row || typeof row.timestamp !== 'number' || typeof row.close !== 'number') throw new Error(`Invalid ${coin} close`);
      return { timestamp: row.timestamp, close: row.close };
    });
    const dvol: DvolObservation[] = entry.dvol.map((item: unknown) => {
      const row = object(item);
      if (!row || typeof row.timestamp !== 'number' || typeof row.value !== 'number') throw new Error(`Invalid ${coin} DVOL`);
      return { timestamp: row.timestamp, value: row.value };
    });
    result[coin] = { closes, dvol };
  }
  return result;
}

async function cachedRequest(endpoint: string, params: Record<string, string>, key: string): Promise<unknown> {
  const file = path.join(CACHE_DIR, `${key}.json`);
  try { return JSON.parse(await readFile(file, 'utf8')) as unknown; }
  catch (error) { if (object(error)?.code !== 'ENOENT') throw error; }
  const url = new URL(`https://www.deribit.com/api/v2/public/${endpoint}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  await sleep(250);
  const response = await politeFetch(url, {}, { label: `Deribit ${endpoint}` });
  const payload: unknown = await response.json();
  if (!object(payload) || object(payload)?.error) throw new Error(`Deribit ${endpoint} returned an error`);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(payload));
  return payload;
}

function resultOf(payload: unknown): Record<string, unknown> {
  const result = object(object(payload)?.result);
  if (!result) throw new Error('Deribit response has no result object');
  return result;
}

async function downloadHistory(coin: 'BTC' | 'ETH', legs: StraddleLeg[]): Promise<VolatilityHistory> {
  const times = legs.filter((leg) => leg.coin === coin).map((leg) => leg.printAtMs);
  if (!times.length) return { closes: [], dvol: [] };
  const first = Math.floor(Math.min(...times) / DAY_MS) * DAY_MS;
  const last = Math.max(...times);
  const closes: DailyClose[] = [];
  const dvol: DvolObservation[] = [];
  // Short chunks keep each public endpoint response bounded and make cache reuse explicit.
  for (let start = first - 32 * DAY_MS; start <= last; start += 20 * DAY_MS) {
    const end = Math.min(start + 20 * DAY_MS, last + DAY_MS);
    const key = `${coin}-chart60-${start}-${end}`;
    const result = resultOf(await cachedRequest('get_tradingview_chart_data', {
      instrument_name: `${coin}-PERPETUAL`, start_timestamp: String(start), end_timestamp: String(end), resolution: '60',
    }, key));
    if (!Array.isArray(result.ticks) || !Array.isArray(result.close)) throw new Error(`Deribit ${key} lacks daily candles`);
    // Deribit's own daily bar ends at 08:00 UTC. The study needs UTC calendar days, so build each
    // day's close from the last hourly bucket (23:00-24:00 UTC), stamped at the midnight that ends it.
    for (let index = 0; index < result.ticks.length; index++) {
      const tick = result.ticks[index];
      const close = result.close[index];
      if (typeof tick === 'number' && typeof close === 'number' && tick % DAY_MS === DAY_MS - 3_600_000) {
        closes.push({ timestamp: tick + 3_600_000, close });
      }
    }
  }
  for (let start = first - 3_600_000; start <= last; start += 20 * DAY_MS) {
    const end = Math.min(start + 20 * DAY_MS, last);
    const key = `${coin}-dvol-${start}-${end}`;
    const result = resultOf(await cachedRequest('get_volatility_index_data', {
      currency: coin, start_timestamp: String(start), end_timestamp: String(end), resolution: '3600',
    }, key));
    if (!Array.isArray(result.data)) throw new Error(`Deribit ${key} lacks DVOL observations`);
    for (const item of result.data) {
      if (!Array.isArray(item) || typeof item[0] !== 'number' || typeof item[4] !== 'number') continue;
      // Deribit stamps a bucket by its start. Its close is known one bucket later, so stamp it then (no look-ahead).
      dvol.push({ timestamp: item[0] + 3_600_000, value: item[4] });
    }
  }
  return { closes, dvol };
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  const fixture = argument('--fixture');
  const outcomes = argument('--outcomes');
  if (fixture !== null && outcomes !== null) throw new Error('Choose one input mode');
  let legs: StraddleLeg[];
  let history: Partial<Record<'BTC' | 'ETH', VolatilityHistory>>;
  let notes: string[] = [];
  if (fixture !== null) {
    const data = object(JSON.parse(await readFile(fixture, 'utf8')) as unknown);
    if (!data) throw new Error('Fixture must be an object with legs and history');
    legs = legsFrom(data.legs);
    history = historyFrom(data.history);
  } else {
    if (outcomes !== null) {
      legs = legsFrom(JSON.parse(await readFile(outcomes, 'utf8')) as unknown);
    } else {
      loadStudyEnv();
      const loaded = await loadStraddleLegs();
      legs = loaded.legs;
      notes = loaded.notes;
    }
    history = {
      BTC: await downloadHistory('BTC', legs),
      ETH: await downloadHistory('ETH', legs),
    };
  }
  const result = evaluateDvolStraddles(legs, history);
  console.log(JSON.stringify(notes.length ? { dataNotes: notes, ...result } : result, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
