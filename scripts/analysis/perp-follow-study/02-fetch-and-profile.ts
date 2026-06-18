/**
 * Part A foundation: for each discovered active address, fetch fills (cached),
 * build round-trips, and compute the trailing-60d metric panel + per-window
 * metrics for the persistence test.
 *
 * Output: data/backups/perp-follow-study/profiles.jsonl  (one row per address)
 * Resumable: skips addresses already in profiles.jsonl.
 */
import * as fs from 'fs';
import { PATHS, ACTIVE_FILTER } from './study-config';
import {
  loadCachedFills,
  fetchFillsByTime,
  saveFills,
  buildAllRoundTrips,
  computeMetrics,
  type Fill,
  type RoundTrip,
} from './lib-fills';
import { windowBounds, ANCHOR_MS, DAY_MS } from '../hyperliquid-persistence/lib';

const DISC = `${PATHS.OUT_DIR}/discovered-addresses.json`;
const OUT = `${PATHS.OUT_DIR}/profiles.jsonl`;
const W5 = windowBounds(5); // trailing 60d [start,end]

// fills endpoint reaches back only ~12k fills. Block-sampling over-represents
// heavy/HFT accounts whose 12k fills span only days/weeks anyway. We fetch from
// the start of window w3 (~180d back) to capture the two regime-break transitions
// (w3->w4, w4->w5) for the persistence pairs that matter most, while bounding
// pagination. Accounts whose retained fills don't reach back simply have fewer
// usable windows (declared limitation).
const FETCH_START = windowBounds(3).start;
const CONCURRENCY = 2;
// Bound runtime + endpoint load: profile only addresses appearing in >=2 sampled
// blocks (genuinely active, less HFT-noise). Declared subset of the 1094 discovered.
const MIN_BLOCK_COUNT = 2;

interface Profile {
  address: string;
  blockCount: number;
  nFillsTotal: number;
  fillSpanDays: number;
  distinctDaysTrailing60: number;
  // trailing-60d panel:
  trailing60: ReturnType<typeof computeMetrics>;
  active: boolean; // passes ACTIVE_FILTER on trailing 60d
  // per-window metrics (index 0..5) for persistence; null if <min trips
  perWindow: Array<{ nTrips: number; winRate: number; pnl: number; pnlRet: number } | null>;
  ethBtcEntryFills: number; // count of ETH/BTC opening fills in trailing window (for Part B power)
}

function perWindowMetrics(trips: RoundTrip[]): Profile['perWindow'] {
  const out: Profile['perWindow'] = [];
  for (let k = 0; k < 6; k++) {
    const { start, end } = windowBounds(k);
    const inW = trips.filter((t) => t.closeTime >= start && t.closeTime < end);
    if (inW.length < 5) {
      out.push(null);
      continue;
    }
    const wins = inW.filter((t) => t.win).length;
    const pnl = inW.reduce((a, t) => a + t.realizedPnl, 0);
    const notion = inW.reduce((a, t) => a + t.entryNotional, 0);
    out.push({ nTrips: inW.length, winRate: wins / inW.length, pnl, pnlRet: notion > 0 ? pnl / notion : 0 });
  }
  return out;
}

function distinctDays(fills: Fill[], start: number, end: number): number {
  const days = new Set<number>();
  for (const f of fills) if (f.time >= start && f.time < end) days.add(Math.floor(f.time / DAY_MS));
  return days.size;
}

async function main() {
  const disc = JSON.parse(fs.readFileSync(DISC, 'utf8'));
  const addrs: string[] = disc.addresses;
  const blockCounts: Record<string, number> = disc.addrBlockCounts;

  const done = new Set<string>();
  if (fs.existsSync(OUT)) {
    for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
      if (line.trim()) done.add((JSON.parse(line) as Profile).address);
    }
  }
  console.log(`[start] ${addrs.length} addrs, ${done.size} already profiled`);

  let processed = 0;
  let active = 0;
  const todo = addrs.filter((a) => !done.has(a) && (blockCounts[a] ?? 0) >= MIN_BLOCK_COUNT);
  console.log(`[filter] ${todo.length} addrs with >=${MIN_BLOCK_COUNT} block appearances to profile`);

  async function profileOne(addr: string): Promise<void> {
    let fills = loadCachedFills(addr);
    if (!fills) {
      try {
        fills = await fetchFillsByTime(addr, FETCH_START);
        if (fills.length) saveFills(addr, fills);
      } catch {
        fills = [];
      }
    }
    const trips = buildAllRoundTrips(fills);
    const trailingTrips = trips.filter((t) => t.closeTime >= W5.start && t.closeTime < W5.end);
    const dDays = distinctDays(fills, W5.start, W5.end);
    const m = computeMetrics(trailingTrips, null);
    const isActive = trailingTrips.length >= ACTIVE_FILTER.MIN_ROUNDTRIPS_60D && dDays >= ACTIVE_FILTER.MIN_DISTINCT_DAYS;
    const ethBtcEntry = fills.filter(
      (f) => (f.coin === 'ETH' || f.coin === 'BTC') && /Open/.test(f.dir) && f.time >= W5.start && f.time < W5.end,
    ).length;
    const span = fills.length ? (fills[fills.length - 1].time - fills[0].time) / DAY_MS : 0;

    const prof: Profile = {
      address: addr,
      blockCount: blockCounts[addr] ?? 0,
      nFillsTotal: fills.length,
      fillSpanDays: span,
      distinctDaysTrailing60: dDays,
      trailing60: m,
      active: isActive,
      perWindow: perWindowMetrics(trips),
      ethBtcEntryFills: ethBtcEntry,
    };
    fs.appendFileSync(OUT, JSON.stringify(prof) + '\n');
    processed++;
    if (isActive) active++;
    if (processed % 50 === 0) console.log(`  processed=${processed}/${todo.length} active=${active}`);
  }

  // simple worker pool
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < todo.length) {
      const i = cursor++;
      await profileOne(todo[i]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`[done] processed=${processed} active=${active}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
