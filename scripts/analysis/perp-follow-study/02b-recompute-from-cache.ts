/**
 * Recompute profiles.jsonl from CACHED fills only (no network). Run after the
 * fetch pass has cached fills, or to apply a corrected metric definition.
 * Reads every cached fill file under perp-follow-study/fills + hyperliquid-study/fills
 * for discovered addresses and rebuilds the profile rows.
 */
import * as fs from 'fs';
import { PATHS, ACTIVE_FILTER } from './study-config';
import { loadCachedFills, buildAllRoundTrips, computeMetrics, type Fill, type RoundTrip } from './lib-fills';
import { windowBounds, DAY_MS } from '../hyperliquid-persistence/lib';

const DISC = `${PATHS.OUT_DIR}/discovered-addresses.json`;
const OUT = `${PATHS.OUT_DIR}/profiles.jsonl`;
const W5 = windowBounds(5);

function perWindowMetrics(trips: RoundTrip[]) {
  const out: Array<{ nTrips: number; winRate: number; pnl: number; pnlRet: number } | null> = [];
  for (let k = 0; k < 6; k++) {
    const { start, end } = windowBounds(k);
    const inW = trips.filter((t) => t.closeTime >= start && t.closeTime < end);
    if (inW.length < 5) { out.push(null); continue; }
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

function main() {
  const disc = JSON.parse(fs.readFileSync(DISC, 'utf8'));
  const addrs: string[] = disc.addresses;
  const blockCounts: Record<string, number> = disc.addrBlockCounts;

  const rows: string[] = [];
  let active = 0, withFills = 0;
  for (const addr of addrs) {
    const fills = loadCachedFills(addr);
    if (!fills || !fills.length) continue;
    withFills++;
    const trips = buildAllRoundTrips(fills);
    const trailingTrips = trips.filter((t) => t.closeTime >= W5.start && t.closeTime < W5.end);
    const dDays = distinctDays(fills, W5.start, W5.end);
    const m = computeMetrics(trailingTrips, null);
    const isActive = trailingTrips.length >= ACTIVE_FILTER.MIN_ROUNDTRIPS_60D && dDays >= ACTIVE_FILTER.MIN_DISTINCT_DAYS;
    if (isActive) active++;
    const ethBtcEntry = fills.filter(
      (f) => (f.coin === 'ETH' || f.coin === 'BTC') && /Open/.test(f.dir) && f.time >= W5.start && f.time < W5.end,
    ).length;
    const span = fills.length ? (fills[fills.length - 1].time - fills[0].time) / DAY_MS : 0;
    rows.push(JSON.stringify({
      address: addr, blockCount: blockCounts[addr] ?? 0, nFillsTotal: fills.length, fillSpanDays: span,
      distinctDaysTrailing60: dDays, trailing60: m, active: isActive, perWindow: perWindowMetrics(trips),
      ethBtcEntryFills: ethBtcEntry,
    }));
  }
  fs.writeFileSync(OUT, rows.join('\n') + '\n');
  console.log(`[recompute] ${rows.length} profiles (with fills ${withFills}), active ${active}`);
}

main();
