/**
 * Shared READ-ONLY I/O for the research study scripts.
 * - env loading from .env.local (never prints values)
 * - Supabase PostgREST SELECT (GET only), paged, with a cache
 * - paced, retrying HTTP (exponential backoff on 429 and 5xx)
 * - paced Hyperliquid info POSTs (read-only query types only)
 * Importing this module has no side effects. Call loadStudyEnv() in main().
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCandleSnapshot } from '@/lib/hyperliquid/candle-service-business-logic';
import type { PriceCandle } from '@/types/trading-core';

export const STUDY_CACHE_ROOT = path.resolve('data/backups/hyperliquid-study');
const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
/** Info request types this module may send. Anything else is refused. */
const READ_ONLY_HL_TYPES = new Set(['meta', 'candleSnapshot', 'fundingHistory', 'predictedFundings']);

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function loadStudyEnv(): void {
  try { process.loadEnvFile('.env.local'); } catch { /* env may already be set */ }
}

function firstEnv(...names: string[]): string | undefined {
  return names.map((name) => process.env[name]).find((value) => value !== undefined && value !== '');
}

export function supabaseConfig(): { url: string; key: string } {
  const url = firstEnv('HL_TRADERS_SUPABASE_URL', 'HL_SUPABASE_URL', 'NEXT_PUBLIC_HL_SUPABASE_URL',
    'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
  const key = firstEnv('HL_TRADERS_SUPABASE_SERVICE_ROLE_KEY', 'HL_TRADERS_SUPABASE_SECRET_KEY',
    'HL_SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_HL_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (!url || !key) {
    throw new Error('Set HL_TRADERS_SUPABASE_URL and HL_TRADERS_SUPABASE_SERVICE_ROLE_KEY (or an accepted fallback) in .env.local');
  }
  return { url: url.replace(/\/$/, ''), key };
}

export function isFresh(savedAt: number, maxAgeMs: number | undefined, now = Date.now()): boolean {
  return maxAgeMs === undefined || now - savedAt <= maxAgeMs;
}

/** JSON file cache. With maxAgeMs, an older file is reloaded. */
export async function cachedJson<T>(dir: string, name: string, load: () => Promise<T>, maxAgeMs?: number): Promise<T> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as { savedAt?: number; value?: T };
    if (typeof raw.savedAt === 'number' && 'value' in raw && isFresh(raw.savedAt, maxAgeMs)) return raw.value as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const value = await load();
  await writeFile(file, JSON.stringify({ savedAt: Date.now(), value }));
  return value;
}

export interface RetryOptions { retries?: number; baseMs?: number; maxMs?: number; label?: string }

/** Exponential backoff delay for attempt n (0-based), honouring Retry-After seconds. PURE. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, retryAfter: string | null, jitter = Math.random()): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const hinted = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0;
  return Math.min(Math.max(hinted, baseMs * 2 ** attempt) + jitter * 250, maxMs);
}

/** fetch with retry on 429, 5xx and network errors. Throws on other non-OK statuses. */
export async function politeFetch(url: string | URL, init: RequestInit = {}, options: RetryOptions = {}): Promise<Response> {
  const { retries = 8, baseMs = 1500, maxMs = 90_000, label = String(url) } = options;
  let last = 'no attempt';
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      if (response.ok) return response;
      last = `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`${label}: HTTP ${response.status}`);
      }
      if (attempt < retries) await sleep(backoffDelay(attempt, baseMs, maxMs, response.headers.get('retry-after')));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${label}: HTTP`)) throw error;
      last = error instanceof Error ? error.message : String(error);
      if (attempt < retries) await sleep(backoffDelay(attempt, baseMs, maxMs, null));
    }
  }
  throw new Error(`${label}: gave up after ${retries + 1} attempts (${last})`);
}

/** Select-only, paged PostgREST read. `filters` are raw PostgREST params, e.g. { mode: 'eq.live' }. */
export async function supabaseSelect(table: string, columns: string,
  filters: Record<string, string> = {}, order = 'id.asc', maxRows = Infinity): Promise<Record<string, unknown>[]> {
  const { url, key } = supabaseConfig();
  const page = Math.min(1000, maxRows);
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += page) {
    const params = new URLSearchParams({ select: columns, order, limit: String(page), offset: String(offset), ...filters });
    const response = await politeFetch(`${url}/rest/v1/${encodeURIComponent(table)}?${params}`, {
      method: 'GET', headers: { apikey: key, Authorization: `Bearer ${key}` },
    }, { label: `Supabase ${table}`, retries: 3 });
    const body = await response.json() as unknown;
    if (!Array.isArray(body)) throw new Error(`Supabase ${table}: response is not an array`);
    rows.push(...body as Record<string, unknown>[]);
    if (body.length < page || rows.length >= maxRows) break;
  }
  return rows;
}

let nextHlSlot = 0;
/** Serial pacing: at most one HL info request per `gapMs`, across all callers in this process. */
async function hlSlot(gapMs: number): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextHlSlot);
  nextHlSlot = at + gapMs;
  if (at > now) await sleep(at - now);
}

export const HL_GAP_MS = Number(process.env.STUDY_HL_GAP_MS ?? 700);

export async function hlInfo<T>(body: { type: string } & Record<string, unknown>): Promise<T> {
  if (!READ_ONLY_HL_TYPES.has(body.type)) throw new Error(`Refusing non-allow-listed HL info type: ${body.type}`);
  await hlSlot(HL_GAP_MS);
  const response = await politeFetch(HL_INFO_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, { label: `HL ${body.type}`, retries: 6, baseMs: 3000, maxMs: 60_000 });
  // After a retry storm, push the shared slot back so later callers do not hammer HL.
  return await response.json() as T;
}

export async function hlCandles(coin: string, interval: string, startTime: number, endTime: number): Promise<PriceCandle[]> {
  const raw = await hlInfo<unknown>({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } });
  return parseCandleSnapshot(raw);
}

export interface HourlyFunding { time: number; fundingHourly: number }

/** Strict paged fundingHistory (throws instead of returning a partial series). */
export async function hlFundingHistory(coin: string, startTime: number, endTime: number): Promise<HourlyFunding[]> {
  const out: HourlyFunding[] = [];
  let cursor = startTime;
  for (let pageNo = 0; pageNo < 200; pageNo++) {
    const raw = await hlInfo<Array<{ time?: number; fundingRate?: string }>>({
      type: 'fundingHistory', coin, startTime: cursor, endTime,
    });
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const row of raw) {
      const time = typeof row.time === 'number' ? row.time : NaN;
      const rate = Number(row.fundingRate);
      if (Number.isFinite(time) && Number.isFinite(rate)) out.push({ time, fundingHourly: rate });
    }
    const last = raw[raw.length - 1]?.time;
    if (typeof last !== 'number' || last < cursor) break;
    if (raw.length < 500) break;
    cursor = last + 1;
  }
  return [...new Map(out.map((p) => [p.time, p])).values()].sort((a, b) => a.time - b.time);
}

/** Nominal hour of the earliest funding row HL holds for a coin, or null. One request. */
export async function hlFirstFunding(coin: string): Promise<number | null> {
  const raw = await hlInfo<Array<{ time?: number }>>({ type: 'fundingHistory', coin, startTime: 0 });
  const time = Array.isArray(raw) && raw.length ? raw[0].time : undefined;
  return typeof time === 'number' ? Math.round(time / 3_600_000) * 3_600_000 : null;
}

export interface HlFundingObservation { coin: string; time: number; hlHourly: number }

/**
 * Parse an HL `predictedFundings` response into hourly HL rates.
 * Shape: [[coin, [[venue, {fundingRate, fundingIntervalHours, ...}] | null, ...]], ...].
 * Rows without a valid HlPerp entry are skipped.
 */
export function parseHlPredictedFundings(payload: unknown, time: number): HlFundingObservation[] {
  if (!Array.isArray(payload)) throw new Error('Unexpected predictedFundings response');
  const out: HlFundingObservation[] = [];
  for (const item of payload) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || !Array.isArray(item[1])) continue;
    const venue = (item[1] as unknown[]).find((v) => Array.isArray(v) && v[0] === 'HlPerp') as
      | [string, { fundingRate?: unknown; fundingIntervalHours?: unknown } | null]
      | undefined;
    const quote = venue?.[1];
    if (!quote) continue;
    const rate = Number(quote.fundingRate);
    const interval = Number(quote.fundingIntervalHours);
    if (!Number.isFinite(rate) || !Number.isFinite(interval) || interval <= 0) continue;
    out.push({ coin: item[0].toUpperCase(), time, hlHourly: rate / interval });
  }
  return out;
}
