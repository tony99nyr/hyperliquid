/** Read-only regime split. Fixture JSON: {outcomes,candlesByCoin}. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { splitRegimeExpectancy, type RegimeOutcome } from '@/lib/backtest/regime-split-expectancy-business-logic';
import type { PriceCandle } from '@/types/trading-core';

const CACHE = path.resolve('data/backups/hyperliquid-study/regime-split-expectancy');
const FOUR_HOURS = 4 * 3_600_000;
const PAGE = 1000;

function option(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : process.argv[at + 1] ?? null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): number {
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new Error(`Invalid timestamp: ${String(value)}`);
  return ms;
}

function num(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid R: ${String(value)}`);
  return n;
}

async function cached<T>(name: string, load: () => Promise<T>): Promise<T> {
  await mkdir(CACHE, { recursive: true });
  const file = path.join(CACHE, name);
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const value = await load();
  await writeFile(file, JSON.stringify(value));
  return value;
}

function database(): { url: string; key: string } {
  const url = process.env.HL_TRADERS_SUPABASE_URL ?? process.env.HL_SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_HL_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Set a Supabase URL and anon key for select-only reads');
  return { url: url.replace(/\/$/, ''), key };
}

async function select(table: string, columns: string): Promise<Record<string, unknown>[]> {
  const { url, key } = database();
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const params = new URLSearchParams({ select: columns, order: 'id.asc', limit: String(PAGE), offset: String(offset) });
    const response = await fetch(`${url}/rest/v1/${table}?${params}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!response.ok) throw new Error(`${table} read failed: ${response.status} ${await response.text()}`);
    const page = await response.json() as unknown;
    if (!Array.isArray(page)) throw new Error(`${table} response is not an array`);
    rows.push(...page.map(record));
    if (page.length < PAGE) break;
  }
  return rows;
}

function outcomesFromRows(outcomes: Record<string, unknown>[], fires: Record<string, unknown>[],
  rungs: Record<string, unknown>[], hypotheses: Record<string, unknown>[]): RegimeOutcome[] {
  const opening = new Set(rungs.filter((row) => row.action === 'open').map((row) => String(row.id)));
  const firstFire = new Map<string, number>();
  for (const fire of fires) {
    if (fire.status !== 'filled' || !opening.has(String(fire.rung_id))) continue;
    const id = String(fire.ladder_id);
    const time = timestamp(fire.fired_at);
    firstFire.set(id, Math.min(firstFire.get(id) ?? Infinity, time));
  }
  const live: RegimeOutcome[] = outcomes.filter((row) => row.mode === 'live' &&
    ['won', 'lost', 'scratch'].includes(String(row.outcome)) && row.realized_r != null &&
    firstFire.has(String(row.ladder_id))).map((row) => ({
    id: String(row.id), source: 'live-ladder', lane: String(row.setup_type), coin: String(row.coin),
    entryTime: firstFire.get(String(row.ladder_id)) as number, netR: num(row.realized_r),
  }));
  const scout: RegimeOutcome[] = hypotheses.filter((row) => row.excluded !== true &&
    ['confirmed', 'invalidated', 'resolved'].includes(String(row.status)) &&
    row.realized_r != null && row.coin && row.created_at).map((row) => ({
    id: String(row.id), source: 'scout', lane: String(row.lane ?? row.setup_type ?? 'unknown'),
    coin: String(row.coin), entryTime: timestamp(row.created_at), netR: num(row.realized_r),
  }));
  return [...live, ...scout];
}

async function realOutcomes(): Promise<RegimeOutcome[]> {
  const tables = await Promise.all([
    cached('ladder_outcomes.json', () => select('ladder_outcomes', 'id,ladder_id,mode,outcome,setup_type,coin,realized_r')),
    cached('ladder_fires.json', () => select('ladder_fires', 'id,ladder_id,rung_id,status,fired_at')),
    cached('ladder_rungs.json', () => select('ladder_rungs', 'id,action')),
    cached('hypotheses.json', () => select('hypotheses', 'id,coin,lane,setup_type,status,excluded,realized_r,created_at')),
  ]);
  return outcomesFromRows(tables[0], tables[1], tables[2], tables[3]);
}

async function candlesFor(outcomes: RegimeOutcome[]): Promise<Record<string, PriceCandle[]>> {
  const result: Record<string, PriceCandle[]> = {};
  for (const coin of [...new Set(outcomes.map((row) => row.coin.toUpperCase()))]) {
    const times = outcomes.filter((row) => row.coin.toUpperCase() === coin).map((row) => row.entryTime);
    const start = Math.min(...times) - 210 * FOUR_HOURS;
    const end = Math.max(...times);
    const pieces: PriceCandle[] = [];
    for (let cursor = start; cursor < end; cursor += 400 * FOUR_HOURS) {
      const stop = Math.min(cursor + 400 * FOUR_HOURS, end);
      const key = `${coin}-${cursor}-${stop}.json`;
      pieces.push(...await cached(key, async () => {
        const response = await fetchCandles(coin, '4h', cursor, stop);
        if (response.stale || response.error) throw new Error(`Candle read failed for ${coin}: ${response.error ?? 'stale'}`);
        return response.candles;
      }));
    }
    result[coin] = [...new Map(pieces.map((bar) => [bar.timestamp, bar])).values()]
      .sort((a, b) => a.timestamp - b.timestamp);
  }
  return result;
}

async function main(): Promise<void> {
  const fixture = option('fixture');
  if (fixture) {
    const value = record(JSON.parse(await readFile(fixture, 'utf8')) as unknown);
    if (!Array.isArray(value.outcomes)) throw new Error('Fixture needs outcomes');
    console.log(JSON.stringify(splitRegimeExpectancy(value.outcomes as RegimeOutcome[],
      record(value.candlesByCoin) as Record<string, PriceCandle[]>), null, 2));
    return;
  }
  const outcomes = await realOutcomes();
  const candles = await candlesFor(outcomes);
  console.log(JSON.stringify({ source: 'select-only Supabase and public HL 4h candles',
    ...splitRegimeExpectancy(outcomes, candles) }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
