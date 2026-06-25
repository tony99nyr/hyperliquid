/**
 * pnpm tsx --tsconfig tsconfig.scripts.json scripts/retry-vet-errors.ts
 *
 * Reset evaluation_requests rows stuck in 'error' back to 'pending' so the
 * research-trader-worker re-drains them. Use after a bulk vet that 429'd HL
 * (the "clearinghouse stale" transient) — but only once the NAS worker is on the
 * PACED build (./update.sh), else it just re-bursts. ENQUEUE-STATE ONLY, no HL.
 */
import { run, line } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';

run(async () => {
  const c = getServiceRoleClient();
  const { data, error } = await c
    .from('evaluation_requests')
    .update({ status: 'pending', error: null })
    .eq('status', 'error')
    .select('id');
  if (error) throw new Error(error.message);
  line(`reset ${data?.length ?? 0} error row(s) → pending. The paced worker will re-drain them.`);
});
