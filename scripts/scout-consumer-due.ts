/**
 * scout-consumer-due: say whether the headless scout consumer must run now.
 *
 *   pnpm scout:consumer-due [--last-attempt <epoch seconds>]
 *
 * Read-only. Called by ops/htpc/scout-consumer.sh each 5-minute timer tick, which
 * passes the time of its last run attempt. Prints `due <reason>` (exit 0) or
 * `wait <reason>` (exit 3). A failed Supabase read exits 1, and the wrapper then
 * skips the cycle: the stale `scout-cycle` heartbeat pages Discord if it lasts.
 */
import { parseArgs, run } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { actTriggerCutoffMs, isConsumerDue, lastConsumerRunMs } from '@/lib/scout/scout-consumer-due-business-logic';

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const attemptSec = Number(args['last-attempt']);
  const db = getServiceRoleClient();
  const beat = await db.from('scout_heartbeat').select('last_tick_at').eq('source', 'scout-cycle').maybeSingle();
  if (beat.error) {
    console.log(`error ${beat.error.message}`);
    process.exit(1);
  }
  const row = beat.data as { last_tick_at: string } | null;
  const heartbeatMs = row ? Date.parse(row.last_tick_at) : null;
  const attemptMs = attemptSec > 0 ? attemptSec * 1000 : null;
  const lastRunAtMs = lastConsumerRunMs(heartbeatMs, attemptMs);
  const cutoffMs = actTriggerCutoffMs(heartbeatMs, attemptMs);
  let newActTriggers = 0;
  if (cutoffMs !== null) {
    const act = await db
      .from('scout_triggers')
      .select('id', { count: 'exact', head: true })
      .eq('urgency', 'act')
      .is('consumed_at', null)
      .gt('at', new Date(cutoffMs).toISOString());
    if (act.error) {
      console.log(`error ${act.error.message}`);
      process.exit(1);
    }
    newActTriggers = act.count ?? 0;
  }
  const verdict = isConsumerDue({ now: Date.now(), lastRunAtMs, newActTriggers });
  console.log(`${verdict.due ? 'due' : 'wait'} ${verdict.reason}`);
  process.exit(verdict.due ? 0 : 3);
});
