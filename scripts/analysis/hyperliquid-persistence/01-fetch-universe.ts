/**
 * Step 1 — Build the study universe from the Hyperliquid leaderboard.
 *
 * Pre-registered rules:
 * - Eligible: allTime volume >= $5M AND month volume > 0 (nonzero month activity).
 * - If eligible > 3000: random sample 2000 (seeded mulberry32, seed recorded)
 *   PLUS always include top 500 by month PnL (flagged 'leaderboard-top').
 */
import {
  LEADERBOARD_TOP_N,
  MIN_ALLTIME_VLM,
  RANDOM_SAMPLE_SIZE,
  RNG_SEED,
  UniverseAccount,
  fetchUrl,
  mulberry32,
  readCache,
  seededSample,
  writeCache,
} from './lib';

interface LeaderboardRow {
  ethAddress: string;
  accountValue: string;
  windowPerformances: Array<[string, { pnl: string; roi: string; vlm: string }]>;
  prize: number;
  displayName: string | null;
}

async function main(): Promise<void> {
  let raw = readCache<{ leaderboardRows: LeaderboardRow[] }>('leaderboard.json');
  if (!raw) {
    console.log('Fetching leaderboard...');
    raw = (await fetchUrl('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard')) as {
      leaderboardRows: LeaderboardRow[];
    };
    writeCache('leaderboard.json', raw);
    writeCache('leaderboard.meta.json', { fetchedAt: new Date().toISOString() });
  } else {
    console.log('Using cached leaderboard.json');
  }

  const rows = raw.leaderboardRows;
  const eligible: UniverseAccount[] = [];
  for (const r of rows) {
    const w = Object.fromEntries(r.windowPerformances);
    const allTimeVlm = parseFloat(w.allTime?.vlm ?? '0');
    const monthVlm = parseFloat(w.month?.vlm ?? '0');
    if (allTimeVlm >= MIN_ALLTIME_VLM && monthVlm > 0) {
      eligible.push({
        address: r.ethAddress.toLowerCase(),
        accountValue: parseFloat(r.accountValue),
        displayName: r.displayName,
        monthPnl: parseFloat(w.month?.pnl ?? '0'),
        monthVlm,
        allTimePnl: parseFloat(w.allTime?.pnl ?? '0'),
        allTimeVlm,
        randomSample: false,
        leaderboardTop: false,
      });
    }
  }
  console.log(`Leaderboard rows: ${rows.length}, eligible (vlm>=$5M & month active): ${eligible.length}`);

  // Top 500 by month PnL
  const byMonthPnl = eligible.slice().sort((a, b) => b.monthPnl - a.monthPnl);
  const topSet = new Set(byMonthPnl.slice(0, LEADERBOARD_TOP_N).map((a) => a.address));

  // Seeded random sample of 2000 from ALL eligible (sorted by address for determinism)
  const rng = mulberry32(RNG_SEED);
  const sortedEligible = eligible.slice().sort((a, b) => a.address.localeCompare(b.address));
  const sampled =
    eligible.length > 3000 ? seededSample(sortedEligible, RANDOM_SAMPLE_SIZE, rng) : sortedEligible;
  const sampleSet = new Set(sampled.map((a) => a.address));

  const universe = eligible.filter((a) => sampleSet.has(a.address) || topSet.has(a.address));
  for (const a of universe) {
    a.randomSample = sampleSet.has(a.address);
    a.leaderboardTop = topSet.has(a.address);
  }

  writeCache('universe.json', {
    meta: {
      seed: RNG_SEED,
      eligibleCount: eligible.length,
      randomSampleSize: sampled.length,
      leaderboardTopSize: topSet.size,
      universeSize: universe.length,
      overlap: universe.filter((a) => a.randomSample && a.leaderboardTop).length,
      builtAt: new Date().toISOString(),
    },
    accounts: universe,
  });
  console.log(
    `Universe: ${universe.length} accounts (random ${sampled.length}, leaderboard-top ${topSet.size}, overlap ${universe.filter((a) => a.randomSample && a.leaderboardTop).length})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
