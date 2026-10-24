/**
 * Read-only OI direction study. No live closes or trading imports.
 * Offline: --fixture path.json with { source, inputs: ReplayInput[], snapshots: OiSnapshot[] }.
 * Default (no flags): reads the replay output written by pnpm backtest:htf-replay
 * (cache dir replay-output.json) and the OI snapshots from Supabase (SELECT only).
 * Optional: --replay path.json ({source, trades} or {source, inputs}) [--snapshots export.json].
 * Env: HL_TRADERS_SUPABASE_URL and HL_TRADERS_SUPABASE_SERVICE_ROLE_KEY (from .env.local).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cachedJson, loadStudyEnv, STUDY_CACHE_ROOT, supabaseSelect } from './_study-io';
import { assessOiDirection, type OiSnapshot } from '@/lib/backtest/oi-direction-filter-business-logic';
import { replayHtfPortfolio, type ReplayInput, type ReplayTrade } from '@/lib/backtest/htf-replay-business-logic';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CACHE = path.join(STUDY_CACHE_ROOT, 'oi-direction-filter');
const DEFAULT_REPLAY = path.join(STUDY_CACHE_ROOT, 'htf-replay', 'replay-output.json');

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

/** Earliest market_snapshots row (one tiny SELECT). Older trades cannot have an OI pair. */
async function earliestSnapshot(): Promise<number | null> {
  const rows = await supabaseSelect('market_snapshots', 'captured_at', {}, 'captured_at.asc', 1);
  const at = Date.parse(String(rows[0]?.captured_at));
  return Number.isFinite(at) ? at : null;
}

/**
 * Select-only and egress-light: for each trade it reads only the two windows the frozen rule
 * can use, [entry-24h-6h, entry-24h] and [entry-6h, entry), for that coin.
 */
async function downloadSnapshots(trades: ReplayTrade[]): Promise<{ snapshots: OiSnapshot[]; since: number | null }> {
  const since = await earliestSnapshot();
  if (since === null) return { snapshots: [], since };
  const seen = new Map<string, OiSnapshot>();
  const candidates = trades.filter((trade) => trade.entryTime >= since);
  for (const trade of candidates) {
    for (const [lo, hi] of [[trade.entryTime - DAY - 6 * HOUR, trade.entryTime - DAY], [trade.entryTime - 6 * HOUR, trade.entryTime - 1]]) {
      const name = `${trade.coin}-${lo}-${hi}.json`;
      const rows = await cachedJson(CACHE, name, () => supabaseSelect('market_snapshots', 'coin,captured_at,open_interest', {
        coin: `eq.${trade.coin}`, and: `(captured_at.gte.${new Date(lo).toISOString()},captured_at.lte.${new Date(hi).toISOString()})`,
      }, 'captured_at.asc', 2000));
      for (const point of snapshotsFrom(rows)) seen.set(`${point.coin}-${point.time}`, point);
    }
  }
  return { snapshots: [...seen.values()], since };
}

function tradesFrom(value: unknown): { source: string; trades: ReplayTrade[]; blockedByCap: number | null; openAtEnd: number | null } {
  const root = object(value);
  if (typeof root.source !== 'string') throw new Error('Replay file needs source');
  if (Array.isArray(root.trades)) {
    return { source: root.source, trades: root.trades as ReplayTrade[],
      blockedByCap: typeof root.blockedByCap === 'number' ? root.blockedByCap : null,
      openAtEnd: typeof root.openAtEnd === 'number' ? root.openAtEnd : null };
  }
  const replay = replayHtfPortfolio(inputsFrom(root).inputs);
  return { source: root.source, trades: replay.trades, blockedByCap: replay.blockedByCap, openAtEnd: replay.openAtEnd };
}

async function main(): Promise<void> {
  const fixture = option('fixture');
  const replayFile = option('replay');
  if (fixture && replayFile) throw new Error('Supply at most one of --fixture or --replay');
  const snapshotFile = option('snapshots');
  if (fixture && snapshotFile) throw new Error('--fixture already contains snapshots');
  const file = fixture ?? replayFile ?? DEFAULT_REPLAY;
  let root: unknown;
  try { root = await jsonFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fixture && !replayFile) {
      throw new Error(`No replay output at ${file}. Run pnpm backtest:htf-replay first (it writes this file).`);
    }
    throw error;
  }
  const replay = tradesFrom(root);
  let snapshots: OiSnapshot[];
  let snapshotSource: string;
  let snapshotsSince: number | null = null;
  if (fixture) { snapshots = snapshotsFrom(root); snapshotSource = 'fixture'; }
  else if (snapshotFile) { snapshots = snapshotsFrom(await jsonFile(snapshotFile)); snapshotSource = snapshotFile; }
  else {
    loadStudyEnv();
    const downloaded = await downloadSnapshots(replay.trades);
    snapshots = downloaded.snapshots;
    snapshotsSince = downloaded.since;
    snapshotSource = 'select-only market_snapshots, per-trade windows, cached';
  }
  const report = assessOiDirection(replay.trades, snapshots);
  console.log(JSON.stringify({ study: 'oi-direction-filter', source: replay.source, snapshotSource,
    marketSnapshotsEarliest: snapshotsSince === null ? null : new Date(snapshotsSince).toISOString(),
    tradesBeforeSnapshotHistory: snapshotsSince === null ? null : replay.trades.filter((t) => t.entryTime < snapshotsSince).length,
    blockedByCap: replay.blockedByCap, openAtEnd: replay.openAtEnd,
    ...report, interpretation: 'Historical replay study only; no live filter change.' }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
