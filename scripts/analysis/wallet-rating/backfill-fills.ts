/**
 * Resume-safe Hyperliquid fills backfill for the wallet-rating dataset.
 *
 * Pulls `userFillsByTime` for every address that is RATED but lacks cached
 * fills (data/backups/hyperliquid-study/fills/<addr>.json), so the copyability
 * scorer + EDT trading-hours analytics can run on the full rated set. Optionally
 * (--expand N) continues into the broader cached universe (universe.json) to grow
 * the rated set beyond the current 58 — but the rated set is ALWAYS completed first.
 *
 * Resume-safe: each wallet is written to its own file the moment it is fetched,
 * and wallets that already have a non-empty fills file are SKIPPED. Re-running
 * after an interruption picks up exactly where it left off. A checkpoint file
 * (fills-backfill-checkpoint.json) records which addresses were attempted +
 * empty (zero fills returned) so we don't re-hammer dead accounts every run.
 *
 * Rate limits: shared throttle + exponential backoff via lib.ts `postInfo`
 * (250ms global spacing, 6 retries with jittered backoff up to 60s on 429/5xx).
 * Fail-soft: a single wallet error is logged and skipped, never aborts the run.
 *
 * HL retention: userFillsByTime keeps only the most-recent ~10-12k fills (probed
 * 2026-06-12). We page forward from lookbackDays ago (config) up to 7 pages of
 * 2000. Coverage (first/last fill date, page-capped?) is logged per wallet.
 *
 * Run:
 *   npx tsx scripts/analysis/wallet-rating/backfill-fills.ts            # complete rated set only
 *   npx tsx scripts/analysis/wallet-rating/backfill-fills.ts --expand 200  # + up to 200 universe accounts
 */
import * as fs from 'fs';
import * as path from 'path';
import { postInfo, DATA_DIR } from '../hyperliquid-persistence/lib';

// Repo root (this file is <repo>/scripts/analysis/wallet-rating/backfill-fills.ts).
const REPO = path.resolve(__dirname, '../../..');
const FILLS_DIR = path.join(DATA_DIR, 'fills');
const RATED_PATH = path.join(REPO, 'data/backups/wallet-rating/rated-wallets.json');
const UNIVERSE_PATH = path.join(DATA_DIR, 'universe.json');
const CHECKPOINT_PATH = path.join(DATA_DIR, 'fills-backfill-checkpoint.json');
const CONFIG_DIR = path.join(REPO, 'scripts/analysis/wallet-rating/configs');

const PAGE_SIZE = 2000;
const MAX_PAGES = 7; // 7 x 2000 = 14k > ~10-12k retention cap

interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  dir: string;
  closedPnl: string;
  fee: string;
}

interface Checkpoint {
  /** addresses confirmed to return ZERO fills (dead/empty) — skip on resume */
  empty: string[];
  /** addresses that errored on the last attempt — retried on resume */
  errored: string[];
  updatedAt: string;
}

function loadCheckpoint(): Checkpoint {
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8')) as Checkpoint;
  } catch {
    return { empty: [], errored: [], updatedAt: new Date().toISOString() };
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  cp.updatedAt = new Date().toISOString();
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

function hasFills(addr: string): boolean {
  const p = path.join(FILLS_DIR, `${addr}.json`);
  if (!fs.existsSync(p)) return false;
  try {
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

/** Lookback start from the active copyability config (lookbackDays), default 365d. */
function lookbackStartMs(): number {
  let lookbackDays = 365;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'manifest.json'), 'utf8'));
    const fname = manifest?.activeByPhilosophy?.copyability;
    if (fname) {
      const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, fname), 'utf8'));
      if (typeof cfg?.eligibility?.lookbackDays === 'number') lookbackDays = cfg.eligibility.lookbackDays;
    }
  } catch {
    /* default */
  }
  return Date.now() - lookbackDays * 86_400_000;
}

/** Fetch all available fills (paged forward, deduped, time-sorted). */
async function fetchFills(addr: string, startTime: number): Promise<{ fills: Fill[]; pageCapped: boolean }> {
  const all: Fill[] = [];
  let cursor = startTime;
  let pageCapped = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await postInfo<Fill[]>({ type: 'userFillsByTime', user: addr, startTime: cursor });
    if (!batch.length) break;
    all.push(...batch);
    const last = batch[batch.length - 1].time;
    if (batch.length < PAGE_SIZE || last <= cursor) break;
    cursor = last + 1;
    if (page === MAX_PAGES - 1) pageCapped = true;
  }
  // dedupe (time|coin|px|sz|dir) and sort
  const seen = new Set<string>();
  const out: Fill[] = [];
  for (const f of all) {
    const k = `${f.time}|${f.coin}|${f.px}|${f.sz}|${f.dir}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  out.sort((a, b) => a.time - b.time);
  return { fills: out, pageCapped };
}

function fmtDate(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : 'n/a';
}

async function main(): Promise<void> {
  fs.mkdirSync(FILLS_DIR, { recursive: true });
  const args = process.argv.slice(2);
  const expandIdx = args.indexOf('--expand');
  const expandN = expandIdx >= 0 ? parseInt(args[expandIdx + 1] || '0', 10) || 0 : 0;

  const cp = loadCheckpoint();
  const emptySet = new Set(cp.empty);
  const startMs = lookbackStartMs();

  // ---- 1. Rated wallets that lack fills (PRIORITY) ----
  const rated = JSON.parse(fs.readFileSync(RATED_PATH, 'utf8'));
  const ratedAddrs: string[] = rated.wallets.map((w: { address: string }) => w.address.toLowerCase());
  const ratedMissing = ratedAddrs.filter((a) => !hasFills(a) && !emptySet.has(a));

  // ---- 2. Optional expansion into the universe ----
  let expandAddrs: string[] = [];
  if (expandN > 0) {
    const uni = JSON.parse(fs.readFileSync(UNIVERSE_PATH, 'utf8'));
    const uniAddrs: string[] = uni.accounts.map((a: { address: string }) => a.address.toLowerCase());
    expandAddrs = uniAddrs
      .filter((a) => !ratedAddrs.includes(a) && !hasFills(a) && !emptySet.has(a))
      .slice(0, expandN);
  }

  const queue = [...ratedMissing, ...expandAddrs];
  console.log('='.repeat(72));
  console.log('HL FILLS BACKFILL (resume-safe)');
  console.log('='.repeat(72));
  console.log(`Rated wallets total:            ${ratedAddrs.length}`);
  console.log(`  already have fills:           ${ratedAddrs.filter(hasFills).length}`);
  console.log(`  known-empty (skipped):        ${ratedAddrs.filter((a) => emptySet.has(a)).length}`);
  console.log(`  to fetch (rated priority):    ${ratedMissing.length}`);
  if (expandN > 0) console.log(`  universe expansion this run:  ${expandAddrs.length} (--expand ${expandN})`);
  console.log(`Lookback start:                 ${fmtDate(startMs)}`);
  console.log(`Fills cache dir:                ${FILLS_DIR}`);
  console.log('');

  let fetched = 0;
  let empty = 0;
  let errored = 0;
  const erroredNow: string[] = [];

  for (let i = 0; i < queue.length; i++) {
    const addr = queue[i];
    const tag = i < ratedMissing.length ? 'RATED' : 'UNIV ';
    try {
      const { fills, pageCapped } = await fetchFills(addr, startMs);
      if (fills.length === 0) {
        emptySet.add(addr);
        empty++;
        console.log(`[${i + 1}/${queue.length}] ${tag} ${addr.slice(0, 10)}  EMPTY (0 fills)`);
        continue;
      }
      fs.writeFileSync(path.join(FILLS_DIR, `${addr}.json`), JSON.stringify(fills));
      fetched++;
      const first = fills[0].time;
      const last = fills[fills.length - 1].time;
      console.log(
        `[${i + 1}/${queue.length}] ${tag} ${addr.slice(0, 10)}  ${fills.length} fills  ` +
          `${fmtDate(first)}..${fmtDate(last)}${pageCapped ? '  [PAGE-CAPPED: retention truncated]' : ''}`,
      );
    } catch (err) {
      errored++;
      erroredNow.push(addr);
      console.log(`[${i + 1}/${queue.length}] ${tag} ${addr.slice(0, 10)}  ERROR: ${(err as Error).message}`);
    }
    // checkpoint every 10 wallets so an overnight interruption loses little
    if ((i + 1) % 10 === 0) {
      cp.empty = [...emptySet];
      cp.errored = erroredNow;
      saveCheckpoint(cp);
    }
  }

  cp.empty = [...emptySet];
  cp.errored = erroredNow;
  saveCheckpoint(cp);

  const ratedHaveNow = ratedAddrs.filter(hasFills).length;
  console.log('');
  console.log('='.repeat(72));
  console.log('BACKFILL SUMMARY');
  console.log('='.repeat(72));
  console.log(`Fetched (non-empty):            ${fetched}`);
  console.log(`Empty (no fills returned):      ${empty}`);
  console.log(`Errored (will retry next run):  ${errored}`);
  console.log(`Rated wallets WITH fills now:   ${ratedHaveNow} / ${ratedAddrs.length}`);
  const stillMissing = ratedAddrs.filter((a) => !hasFills(a));
  if (stillMissing.length) {
    console.log(`Rated still missing fills:      ${stillMissing.length}`);
    console.log(`  (${stillMissing.filter((a) => emptySet.has(a)).length} confirmed empty/dead, ` +
      `${stillMissing.filter((a) => !emptySet.has(a)).length} pending/errored)`);
  } else {
    console.log('All rated wallets now have fills (or are confirmed empty).');
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
