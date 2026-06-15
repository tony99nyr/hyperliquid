/**
 * skill:assess-trade-health entrypoint (thin I/O). ADVISORY ONLY — never trades.
 *
 * Runs the multi-timeframe health engine on the open position, writes a
 * health_snapshots row (so the cockpit HealthPanel live-renders it), and prints
 * a hold / trim / exit recommendation via the PURE recommender. No action is
 * taken — if the advice is to exit, the user runs advise-exit next.
 *
 * Usage:
 *   pnpm skill:assess-health --session <id> --coin ETH --side long --entry 2000 [--stop 1900]
 */

import { parseArgs, requireString, optionalNumber, header, line, run } from './_skill-runtime';
import { assessAndPersistHealth } from '@/lib/health/health-engine';
import { recommendFromHealth } from '@/lib/skills/assess-health-business-logic';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import type { PositionSide } from '@/types/position';

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const sessionId = requireString(args, 'session');
  const coin = requireString(args, 'coin').toUpperCase();
  const sideRaw = requireString(args, 'side').toLowerCase();
  if (sideRaw !== 'long' && sideRaw !== 'short' && sideRaw !== 'flat') {
    throw new Error('--side must be long, short, or flat');
  }
  const side = sideRaw as PositionSide;
  const entryPx = optionalNumber(args, 'entry', 0);
  const stopPx = typeof args['stop'] === 'string' ? Number(args['stop']) : undefined;

  header(`assess-trade-health — ${coin} ${side}`);
  line('Fetching 1d/8h/1h/15m candles and composing the health engine (read-only)…');

  const health = await assessAndPersistHealth(sessionId, coin, {
    side,
    entryPx,
    stopPx: stopPx !== undefined && Number.isFinite(stopPx) ? stopPx : undefined,
  });

  header('Health snapshot (written to health_snapshots)');
  line(`score: ${Math.round(health.score)}/100`);
  line(`P(continuation): ${(health.pContinuation * 100).toFixed(0)}%   P(adverse): ${(health.pAdverse * 100).toFixed(0)}%`);
  line(`alerts: ${health.alerts.length ? health.alerts.join(', ') : 'none'}`);
  for (const r of health.timeframeReads) {
    line(`  ${r.timeframe}: ${r.regime} ${Math.round(r.confidence * 100)}% (w=${r.weight})`);
  }

  const rec = recommendFromHealth(health);
  header(`Recommendation: ${rec.action.toUpperCase()}`);
  line(rec.reason);

  await writeAnalysisLog({
    sessionId,
    source: 'assess-trade-health',
    message: `Health ${Math.round(health.score)} → ${rec.action.toUpperCase()}: ${rec.reason}`,
    severity: rec.action === 'exit' ? 'danger' : rec.action === 'trim' ? 'warn' : 'info',
  });
  line('\nThis is advisory. To act on an exit, run advise-exit (you will confirm before anything executes).');
});
