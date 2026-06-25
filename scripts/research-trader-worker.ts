/**
 * pnpm research-trader-worker — drains the on-demand vetting queue (PR-3).
 *
 * An always-on NON-AGENT poller (runs on the NAS alongside trader-watch). It claims
 * pending `evaluation_requests`, fetches the wallet's HL fills + clearinghouse,
 * computes the copyability fingerprint, and writes a `trader_evaluations` row. The
 * heavy deep-fill fetch lives HERE (one NAS IP), never on Vercel (review A3).
 *
 * READ-ONLY w.r.t. trading — it never imports the fill/execution path.
 *
 * Usage:
 *   pnpm research-trader-worker          # poll forever (~5s when idle)
 *   pnpm research-trader-worker --once   # drain the queue once + exit (verification)
 */

import { parseArgs, header, line, run } from './_skill-runtime';
import { processNextEvaluation } from '@/lib/hyperliquid/research-trader-service';

const POLL_MS = 5000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const once = args['once'] === true || args['once'] === 'true';

  header(once ? 'research-trader worker — drain once' : 'research-trader worker — poll loop (Ctrl-C to stop)');

  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  let drained = 0;
  while (!stopping) {
    let addr: string | null = null;
    try {
      addr = await processNextEvaluation();
    } catch (err) {
      line(`WARN process error (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (addr) {
      drained += 1;
      line(`[${new Date().toISOString()}] processed ${addr}`);
      continue; // keep draining while work remains
    }
    if (once) {
      line(`queue empty — drained ${drained} this run (--once).`);
      return;
    }
    await sleep(POLL_MS);
  }
  line('research-trader worker stopped cleanly.');
});
