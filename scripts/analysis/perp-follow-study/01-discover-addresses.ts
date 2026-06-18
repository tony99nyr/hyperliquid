/**
 * Part-Discovery: harvest distinct ACTIVE trader addresses OFF the leaderboard,
 * by sampling Hyperliquid L1 blocks across the trailing-60d window and unioning
 * the `user` addresses found in block txs.
 *
 * Honest coverage: this is a SAMPLE of blocks, not a census. We log the number
 * of blocks sampled, distinct addresses found, and the saturation curve.
 *
 * Output: data/backups/perp-follow-study/discovered-addresses.json
 *   { meta:{...}, addresses:[...], addrBlockCounts:{addr:count} }
 */
import * as fs from 'fs';
import { DISCOVERY, PATHS, RNG_SEED_DISCOVERY } from './study-config';
import { mulberry32 } from '../hyperliquid-persistence/lib';

const OUT = `${PATHS.OUT_DIR}/discovered-addresses.json`;
const SPACING = DISCOVERY.REQUEST_SPACING_MS;

// Calibrated block<->time anchors (probed 2026-06-13, UTC ms):
//   block 964,000,000 -> 1776553425228 (2026-04-18T23:03Z)
//   block 1,000,000,000 -> ~2026-05-17T12:50Z
//   block 1,034,000,000 -> 1781360080533 (2026-06-13T14:14Z)
// Window target [2026-04-13, 2026-06-12]. Approx block bounds via local rate ~13.46/s.
const WIN_START_MS = Date.UTC(2026, 3, 13); // Apr 13
const WIN_END_MS = Date.UTC(2026, 5, 12, 23, 59); // Jun 12 end-of-day
// Block search bounds (slightly wide; we filter by blockTime).
const BLOCK_LO = 957_000_000;
const BLOCK_HI = 1_033_000_000;

interface BlockTx { user?: string; action?: { type?: string } }
interface BlockDetails { blockTime: number; numTxs: number; txs: BlockTx[] }

let lastReq = 0;
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const wait = lastReq + SPACING - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  return fn();
}

async function fetchBlock(height: number, retries = 4): Promise<BlockDetails | null> {
  for (let a = 0; a <= retries; a++) {
    try {
      const res = await paced(() =>
        fetch(DISCOVERY.EXPLORER_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'blockDetails', height }),
          signal: AbortSignal.timeout(30_000),
        }),
      );
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** a));
        continue;
      }
      const j = (await res.json()) as { blockDetails: BlockDetails | null };
      if (!j.blockDetails) {
        // null => throttled or out-of-range; back off and retry a couple times
        await new Promise((r) => setTimeout(r, 1500 * 2 ** a));
        continue;
      }
      return j.blockDetails;
    } catch {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** a));
    }
  }
  return null;
}

async function main() {
  // Resume support
  let addrBlockCounts: Record<string, number> = {};
  let sampledBlocks: number[] = [];
  let inWindowBlocks = 0;
  if (fs.existsSync(OUT)) {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    addrBlockCounts = prev.addrBlockCounts ?? {};
    sampledBlocks = prev.meta?.sampledBlockHeights ?? [];
    inWindowBlocks = prev.meta?.inWindowBlocks ?? 0;
    console.log(`[resume] ${Object.keys(addrBlockCounts).length} addrs, ${sampledBlocks.length} blocks already sampled`);
  }
  const seen = new Set(sampledBlocks);
  const rng = mulberry32(RNG_SEED_DISCOVERY + sampledBlocks.length);

  const target = DISCOVERY.TARGET_BLOCK_SAMPLES;
  const saturation: Array<[number, number]> = []; // [blocksSampled, distinctAddrs]
  let consecutiveNull = 0;

  while (sampledBlocks.length < target) {
    const h = BLOCK_LO + Math.floor(rng() * (BLOCK_HI - BLOCK_LO));
    if (seen.has(h)) continue;
    seen.add(h);
    const b = await fetchBlock(h);
    if (!b) {
      // Failed fetch (transient 429/timeout): do NOT count as a sample, just skip.
      consecutiveNull++;
      seen.delete(h); // allow re-draw later
      if (consecutiveNull > 40) {
        console.log('[abort] >40 consecutive failed fetches — endpoint throttling hard; saving partial');
        break;
      }
      continue;
    }
    sampledBlocks.push(h);
    consecutiveNull = 0;
    if (b.blockTime < WIN_START_MS || b.blockTime > WIN_END_MS) continue; // outside 60d
    inWindowBlocks++;
    for (const tx of b.txs ?? []) {
      if (tx.user) {
        const a = tx.user.toLowerCase();
        addrBlockCounts[a] = (addrBlockCounts[a] ?? 0) + 1;
      }
    }
    if (sampledBlocks.length % 25 === 0) {
      const n = Object.keys(addrBlockCounts).length;
      saturation.push([sampledBlocks.length, n]);
      console.log(`  sampled=${sampledBlocks.length} inWindow=${inWindowBlocks} distinctAddrs=${n}`);
      // checkpoint
      fs.writeFileSync(
        OUT,
        JSON.stringify({
          meta: {
            sampledBlocks: sampledBlocks.length,
            inWindowBlocks,
            distinctAddrs: n,
            sampledBlockHeights: sampledBlocks,
            saturation,
            blockLo: BLOCK_LO,
            blockHi: BLOCK_HI,
            winStartMs: WIN_START_MS,
            winEndMs: WIN_END_MS,
          },
          addrBlockCounts,
        }),
      );
    }
  }

  const addresses = Object.keys(addrBlockCounts);
  fs.writeFileSync(
    OUT,
    JSON.stringify({
      meta: {
        sampledBlocks: sampledBlocks.length,
        inWindowBlocks,
        distinctAddrs: addresses.length,
        sampledBlockHeights: sampledBlocks,
        saturation,
        blockLo: BLOCK_LO,
        blockHi: BLOCK_HI,
        winStartMs: WIN_START_MS,
        winEndMs: WIN_END_MS,
        note: 'Block SAMPLE not census. Heavy traders over-represented (appear in more blocks).',
      },
      addresses,
      addrBlockCounts,
    }),
  );
  console.log(`[done] ${addresses.length} distinct active addresses from ${inWindowBlocks} in-window blocks`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
