/** Freeze or score performance forecasts. Persists only with --write. */

import { parseArgs, run } from './_skill-runtime';
import {
  freezePerformanceForecast,
  scorePerformanceForecasts,
} from '@/lib/performance/lane-performance-service';

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const freeze = args['freeze'] === true;
  const score = args['score'] === true;
  if (freeze && score) throw new Error('Choose one action: --freeze or --score.');

  const write = args['write'] === true;
  const result = !score
    ? await freezePerformanceForecast(write)
    : await scorePerformanceForecasts(write);
  console.log(JSON.stringify({ action: freeze ? 'freeze' : 'score', written: write, result }, null, 2));
});
