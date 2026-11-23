/**
 * scout-heartbeat-check: print the age of the scout-watch heartbeat row, for the NAS
 * install script (ops/nas/install.sh).
 *
 * The install script uses the age as an interlock: a fresh row means a scout-watch
 * daemon still runs somewhere (the office box), and two daemons double-write.
 * Read-only. Prints one line: `age_sec=<n> status=<s> detail=<d>`, or `age_sec=none`
 * when the row is absent. Exits 1 only when Supabase cannot be read.
 */
import { run } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';

run(async () => {
  const { data, error } = await getServiceRoleClient()
    .from('scout_heartbeat')
    .select('last_tick_at, status, detail')
    .eq('source', 'scout-watch')
    .maybeSingle();
  if (error) {
    console.log(`age_sec=error ${error.message}`);
    process.exit(1);
  }
  if (!data) {
    console.log('age_sec=none');
    return;
  }
  const row = data as { last_tick_at: string; status: string | null; detail: string | null };
  const age = Math.round((Date.now() - Date.parse(row.last_tick_at)) / 1000);
  console.log(`age_sec=${age} status=${row.status ?? ''} detail=${row.detail ?? ''}`);
});
