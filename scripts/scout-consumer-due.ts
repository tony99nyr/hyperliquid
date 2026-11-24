/**
 * scout-consumer-due: say whether the headless scout consumer must run now.
 *
 * Read-only. Called by ops/htpc/scout-consumer.sh each 5-minute timer tick.
 * Prints `due <reason>` (exit 0) or `wait <reason>` (exit 3). A failed Supabase read
 * exits 1, and the wrapper then skips the cycle: the stale `scout-cycle` heartbeat
 * pages Discord if the outage lasts.
 */
import { run } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { isConsumerDue } from '@/lib/scout/scout-consumer-due-business-logic';

run(async () => {
  const db = getServiceRoleClient();
  const [beat, act] = await Promise.all([
    db.from('scout_heartbeat').select('last_tick_at').eq('source', 'scout-cycle').maybeSingle(),
    db.from('scout_triggers').select('id', { count: 'exact', head: true }).eq('urgency', 'act').is('consumed_at', null),
  ]);
  if (beat.error || act.error) {
    console.log(`error ${beat.error?.message ?? act.error?.message}`);
    process.exit(1);
  }
  const row = beat.data as { last_tick_at: string } | null;
  const verdict = isConsumerDue({
    now: Date.now(),
    lastCycleAtMs: row ? Date.parse(row.last_tick_at) : null,
    unconsumedActTriggers: act.count ?? 0,
  });
  console.log(`${verdict.due ? 'due' : 'wait'} ${verdict.reason}`);
  process.exit(verdict.due ? 0 : 3);
});
