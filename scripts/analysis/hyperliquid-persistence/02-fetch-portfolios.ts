/**
 * Step 2 — Fetch per-account portfolio history for the universe.
 * Caches to portfolios.jsonl (resumable: already-fetched addresses are skipped).
 */
import { PortfolioResponse, UniverseAccount, appendJsonl, loadJsonl, postInfo, readCache } from './lib';

async function main(): Promise<void> {
  const universe = readCache<{ accounts: UniverseAccount[] }>('universe.json');
  if (!universe) throw new Error('Run 01-fetch-universe.ts first');

  const existing = new Set(
    loadJsonl<{ address: string }>('portfolios.jsonl').map((r) => r.address),
  );
  const todo = universe.accounts.filter((a) => !existing.has(a.address));
  console.log(`Universe ${universe.accounts.length}, cached ${existing.size}, to fetch ${todo.length}`);

  let done = 0;
  let failed = 0;
  for (const acct of todo) {
    try {
      const data = await postInfo<PortfolioResponse>({ type: 'portfolio', user: acct.address });
      appendJsonl('portfolios.jsonl', { address: acct.address, data });
    } catch (err) {
      failed++;
      appendJsonl('portfolios.jsonl', { address: acct.address, data: null, error: String(err) });
    }
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${todo.length} (failed: ${failed})`);
  }
  console.log(`Done. Fetched ${done}, failed ${failed}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
