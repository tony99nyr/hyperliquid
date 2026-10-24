/** Read-only lane performance report for desk retros. */

import { parseArgs, run } from './_skill-runtime';
import {
  getLanePerformanceReport,
  getLatestScoutReviewAt,
} from '@/lib/performance/lane-performance-service';
import { renderLanePerformanceMarkdown } from '@/lib/performance/lane-performance-markdown';

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const json = args['json'] === true;
  const md = args['md'] === true;
  if (json && md) throw new Error('Choose one output mode: --json or --md.');

  let since = typeof args['since'] === 'string' ? args['since'] : undefined;
  if (since === 'last-retro') {
    since = (await getLatestScoutReviewAt()) ?? undefined;
    if (!since) throw new Error('No completed scout review exists for --since last-retro.');
  }
  const lane = typeof args['lane'] === 'string' ? args['lane'] : undefined;
  const report = await getLanePerformanceReport({ since, lane });
  console.log(md ? renderLanePerformanceMarkdown(report) : JSON.stringify(report, null, 2));
});
