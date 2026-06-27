/**
 * pnpm scout:lanes — compute + persist the per-lane scorecard snapshot the cockpit
 * Scout tab reads. One-shot (the NAS provides cadence via nas-watch.sh); the
 * benchmarks fetch HL history, so this belongs on the tick, not the UI poll.
 * NEVER trades.
 */

import { run } from './_skill-runtime';
import { computeScoutLaneCards, persistScoutLaneCards } from '@/lib/scout/lane-scorecard-service';

async function main(): Promise<void> {
  const now = Date.now();
  const result = await computeScoutLaneCards(now);
  await persistScoutLaneCards(result, now);
  console.log(
    `[scout-lanes] persisted account + ${result.lanes.length} lane(s): ${result.lanes.map((l) => `${l.lane}(${l.verdict})`).join(', ')}`,
  );
}

// run() loads .env.local AND installs the `ws` WebSocket polyfill (Node < 22 has no
// native global one, which Supabase createClient needs) — the same bootstrap the NAS
// daemons use — then runs main with error handling.
run(main);
