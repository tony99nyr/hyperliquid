/**
 * Read-only OI direction study. No live closes or trading imports.
 * Offline: --fixture path.json with { source, inputs: ReplayInput[], snapshots: OiSnapshot[] }.
 * Real data: --replay path.json [--snapshots export.json]. The replay file has
 * { source, inputs: ReplayInput[] }, as in backtest-htf-replay.ts. Without a
 * snapshot export, this script downloads select-only market_snapshots pages.
 * Set HL_TRADERS_SUPABASE_URL and HL_TRADERS_SUPABASE_SERVICE_ROLE_KEY for that.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assessOiDirection, type OiSnapshot } from '@/lib/backtest/oi-direction-filter-business-logic';
import { replayHtfPortfolio, type ReplayInput } from '@/lib/backtest/htf-replay-business-logic';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CACHE = path.resolve('data/backups/hyperliquid-study/oi-direction-filter');

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected JSON object');
  }
  return value as Record<string, unknown>;
}

async function jsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

function inputsFrom(value: unknown): { source: string; inputs: ReplayInput[] } {
  const root = object(value);
  if (typeof root.source !== 'string' || !Array.isArray(root.inputs) || !root.inputs.length) {
    throw new Error('Replay file needs source and non-empty inputs');
  }
  const inputs = root.inputs.map((raw): ReplayInput => {
    const row = object(raw);
    if (typeof row.coin !== 'string' || !Array.isArray(row.bars) ||
      row.listing === null || typeof row.listing !== 'object') {
      throw new Error('Invalid replay input');
    }
    if (typeof row.fundingHourly === 'number') {
      const bars = row.bars as Array<{ time: number }>;
      if (!bars.length || bars.some((bar) => !Number.isFinite(bar.time))) {
        throw new Error('Synthetic fixture needs timed bars');
      }
      const funding = [];
      for (let time = bars[0].time; time <= bars[bars.length - 1].time + DAY; time += HOUR) {
        funding.push({ time, fundingHourly: row.fundingHourly });
      }
      return { coin: row.coin, listing: row.listing as ReplayInput['listing'],
        bars: row.bars as ReplayInput['bars'], funding };
    }
    if (!Array.isArray(row.funding)) throw new Error('Replay input needs funding');
    return row as unknown as ReplayInput;
  });
  return { source: root.source, inputs };
}

function snapshotsFrom(value: unknown): OiSnapshot[] {
  const rows = Array.isArray(value) ? value : object(value).snapshots;
  if (!Array.isArray(rows)) throw new Error('Snapshot export needs an array or snapshots array');
  return rows.map((raw): OiSnapshot => {
    const row = object(raw);
    const time = typeof row.time === 'number' ? row.time
      : typeof row.captured_at === 'string' ? Date.parse(row.captured_at) : NaN;
    if (typeof row.coin !== 'string' || !Number.isFinite(time) ||
      (row.openInterest !== null && row.openInterest !== undefined &&
      typeof row.openInterest !== 'number') ||
      (row.open_interest !== null && row.open_interest !== undefined &&
      typeof row.open_interest !== 'number')) {
      throw new Error('Invalid snapshot row');
    }
    const openInterest = row.openInterest ?? row.open_interest ?? null;
    return { coin: row.coin, time, openInterest: openInterest as number | null };
  });
}

async function downloadSnapshots(coins: string[], from: number, to: number): Promise<OiSnapshot[]> {
  await mkdir(CACHE, { recursive: true });
  const key = `${coins.join('-')}-${from}-${to}.json`;
  const file = path.join(CACHE, key);
  try { return snapshotsFrom(await jsonFile(file)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const base = process.env.HL_TRADERS_SUPABASE_URL;
  const token = process.env.HL_TRADERS_SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !token) throw new Error('Set HL_TRADERS_SUPABASE_URL and HL_TRADERS_SUPABASE_SERVICE_ROLE_KEY');
  const all: OiSnapshot[] = [];
  for (let offset = 0; ; offset += 1000) {
    const url = new URL('/rest/v1/market_snapshots', base);
    url.searchParams.set('select', 'coin,captured_at,open_interest');
    url.searchParams.set('coin', `in.(${coins.join(',')})`);
    url.searchParams.append('captured_at', `gte.${new Date(from).toISOString()}`);
    url.searchParams.append('captured_at', `lte.${new Date(to).toISOString()}`);
    url.searchParams.set('order', 'captured_at.asc,coin.asc');
    url.searchParams.set('limit', '1000');
    url.searchParams.set('offset', String(offset));
    const response = await fetch(url, { headers: { apikey: token, Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Snapshot SELECT failed: ${response.status} ${response.statusText}`);
    const page = snapshotsFrom(await response.json() as unknown);
    all.push(...page);
    if (page.length < 1000) break;
  }
  await writeFile(file, JSON.stringify(all));
  return all;
}

async function main(): Promise<void> {
  const fixture = option('fixture');
  const replayFile = option('replay');
  if (Boolean(fixture) === Boolean(replayFile)) {
    throw new Error('Supply exactly one of --fixture or --replay');
  }
  const root = object(await jsonFile((fixture ?? replayFile) as string));
  const replayInput = inputsFrom(root);
  const replay = replayHtfPortfolio(replayInput.inputs);
  const snapshotFile = option('snapshots');
  if (fixture && snapshotFile) throw new Error('--fixture already contains snapshots');
  const snapshots = fixture ? snapshotsFrom(root)
    : snapshotFile ? snapshotsFrom(await jsonFile(snapshotFile))
      : replay.trades.length ? await downloadSnapshots(
        [...new Set(replay.trades.map((trade) => trade.coin))].sort(),
        Math.min(...replay.trades.map((trade) => trade.entryTime)) - DAY - 6 * HOUR,
        Math.max(...replay.trades.map((trade) => trade.entryTime)),
      ) : [];
  const report = assessOiDirection(replay.trades, snapshots);
  console.log(JSON.stringify({ study: 'oi-direction-filter', source: replayInput.source,
    snapshotSource: fixture ? 'fixture' : snapshotFile ?? 'select-only market_snapshots cache',
    blockedByCap: replay.blockedByCap, openAtEnd: replay.openAtEnd,
    ...report, interpretation: 'Historical replay study only; no live filter change.' }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
