/**
 * pnpm tsx --tsconfig tsconfig.scripts.json scripts/enqueue-all-vets.ts [N]
 *
 * One-off: enqueue copyability vets for the top-N rated traders (the cockpit's
 * displayed pool — default 150). Writes `pending` evaluation_requests rows ONLY;
 * the NAS research-trader-worker drains them. enqueueEvaluation is idempotent
 * (no-op if a vet is already pending/processing or — by the worker's done-check —
 * recently completed), so re-running is safe.
 *
 * READ + ENQUEUE ONLY: never fetches HL fills, never trades.
 */

import { header, line, run } from './_skill-runtime';
import { getRailTraders } from '@/lib/hyperliquid/top-traders-service';
import { enqueueEvaluation } from '@/lib/hyperliquid/research-trader-service';

run(async () => {
  const n = Number(process.argv[2] ?? 150);
  const traders = getRailTraders(Number.isFinite(n) && n > 0 ? n : 150);
  header(`enqueue-all-vets — top ${traders.length} traders`);

  let queued = 0;
  let skipped = 0;
  let failed = 0;
  for (const t of traders) {
    try {
      const { queued: q } = await enqueueEvaluation(t.address);
      if (q) queued++;
      else skipped++;
    } catch (err) {
      failed++;
      line(`  FAILED ${t.address}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  line('');
  line(`queued ${queued} · skipped (already pending/processing) ${skipped} · failed ${failed}`);
  line('The NAS research-trader-worker will drain these one at a time (~10–45s each).');
  line('Watch progress: services/research-trader-worker/status.sh — or re-run review-trader per address.');
});
