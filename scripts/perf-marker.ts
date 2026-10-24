/** Propose a performance change marker. Persists only with --write. */

import { parseArgs, run } from './_skill-runtime';
import { proposePerformanceMarker } from '@/lib/performance/lane-performance-service';

function required(args: Record<string, string | boolean>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required --${key} <value>`);
  }
  return value.trim();
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (process.argv[2] !== 'propose') throw new Error('Use `perf:marker propose` to create a marker proposal.');

  const at = args['at'] === undefined ? new Date().toISOString() : required(args, 'at');
  if (!Number.isFinite(Date.parse(at))) throw new Error(`Invalid --at timestamp: ${at}`);
  const lanes = typeof args['lanes'] === 'string' ? args['lanes'].split(',').map((lane) => lane.trim()).filter(Boolean) : [];
  const source = typeof args['source'] === 'string' ? args['source'] : 'manual';
  const validSources = new Set(['commit', 'manifest', 'prereg', 'flag', 'manual']);
  if (!validSources.has(source)) throw new Error(`Invalid --source: ${source}`);

  const marker = await proposePerformanceMarker({
    kind: required(args, 'kind'),
    title: required(args, 'title'),
    note: typeof args['note'] === 'string' ? args['note'] : '',
    source,
    lanes,
    ref: typeof args['ref'] === 'string' ? args['ref'] : null,
    at,
    proposedBy: typeof args['proposed-by'] === 'string'
      ? args['proposed-by']
      : process.env.PERF_PROPOSED_BY ?? 'agent',
  }, args['write'] === true);

  console.log(JSON.stringify({ written: args['write'] === true, marker }, null, 2));
});
