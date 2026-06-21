/**
 * rubric-scan — compute the deterministic rubric and write it to Supabase.
 *
 *   pnpm rubric --once            # full opportunity scan (all coins) + reviews, once
 *   pnpm rubric --once --review   # ONLY the per-position review pass (the 5-min tick)
 *   pnpm rubric --interval 1200   # loop the full scan every N seconds
 *
 * NON-AGENT, deterministic, no LLM. Reads HL + leader_positions, writes
 * rubric_scores + position_reviews via the service role. NEVER trades.
 */

import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import { runRubricScan, runRubricReviews } from '@/lib/rubric/rubric-scan-service';

const DEFAULT_INTERVAL_SECONDS = 1200; // 20 min
const MIN_INTERVAL_SECONDS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function reviewPass(): Promise<void> {
  const t0 = Date.now();
  const { reviewed } = await runRubricReviews({ now: Date.now() });
  line(`reviews: ${reviewed} open position(s) reviewed (${Date.now() - t0}ms)`);
}

async function fullScan(): Promise<void> {
  const t0 = Date.now();
  const { scored, coins } = await runRubricScan({ now: Date.now() });
  line(`scan: scored ${scored} side-sets for [${coins.join(', ')}] (${Date.now() - t0}ms)`);
  await reviewPass();
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const once = args['once'] === true || args['once'] === 'true';
  const reviewOnly = args['review'] === true || args['review'] === 'true';

  if (reviewOnly) {
    header('rubric — review pass (--review)');
    line('Per-open-position health + verdict → position_reviews. NEVER trades.');
    await reviewPass();
    return;
  }

  if (once) {
    header('rubric — single scan (--once)');
    line('Deterministic opportunity scan → rubric_scores. NEVER trades.');
    await fullScan();
    line('Done (--once).');
    return;
  }

  const interval = Math.max(MIN_INTERVAL_SECONDS, optionalNumber(args, 'interval', DEFAULT_INTERVAL_SECONDS));
  header(`rubric — loop every ${interval}s (Ctrl-C to stop)`);
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      stopping = true;
      line(`\nReceived ${sig} — finishing the in-flight scan, then exiting…`);
    });
  }
  while (!stopping) {
    try {
      await fullScan();
    } catch (e) {
      line(`scan error: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (let i = 0; i < interval && !stopping; i++) await sleep(1000);
  }
  line('Stopped.');
});
