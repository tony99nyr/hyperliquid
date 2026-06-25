/**
 * pnpm tsx --tsconfig tsconfig.scripts.json scripts/vet-status.ts
 *
 * Progress view for the copyability vetting queue: evaluation_requests by status +
 * the persisted trader_evaluations verdict breakdown. READ-ONLY.
 */
import { run, line } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';

run(async () => {
  const c = getServiceRoleClient();
  const reqs = await c.from('evaluation_requests').select('status');
  const evals = await c.from('trader_evaluations').select('verdict');
  const byStatus: Record<string, number> = {};
  for (const r of (reqs.data ?? []) as { status: string }[]) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const byVerdict: Record<string, number> = {};
  for (const r of (evals.data ?? []) as { verdict: string }[]) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  line('evaluation_requests: ' + JSON.stringify(byStatus));
  line('trader_evaluations:  ' + JSON.stringify(byVerdict) + '  (total ' + (evals.data ?? []).length + ')');
});
