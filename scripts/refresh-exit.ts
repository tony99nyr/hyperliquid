/**
 * skill:refresh-exit entrypoint (thin I/O). NON-ACTION — re-ARMS the backstop.
 *
 * This NEVER places a trade. It refreshes the always-on Safe-Exit plan so the
 * panic button is backed by a FRESH, SMART reduce-only exit (not just the
 * mechanical market-close fallback the route builds when no plan exists).
 *
 * Each call: load the live position (session, coin), fetch a fresh l2 book, run
 * the health engine (read-only), call the PURE `buildBestExitPlan` to choose the
 * best capital-retaining reduce-only exit (MARKET when adverse/thin, LIMIT at the
 * favorable side when calm + deep), and upsert the `safe_exit_plan` row. Bumping
 * `updated_at` keeps the freshness check happy (Claude is keeping it current).
 *
 * Claude calls this every monitor cycle (see the run-session SKILL.md playbook).
 * It only writes a PLAN row; executing it is the user's Safe-Exit button.
 *
 * Usage:
 *   pnpm skill:refresh-exit --session <id> --coin ETH [--entry 2000] [--stop 1900]
 */

import { randomUUID } from 'node:crypto';
import { parseArgs, requireString, optionalNumber, header, line, run } from './_skill-runtime';
import { loadPosition } from '@/lib/cockpit/fill-persistence-service';
import { fetchL2Book } from '@/lib/hyperliquid/hyperliquid-info-service';
import { assessAndPersistHealth } from '@/lib/health/health-engine';
import { buildBestExitPlan } from '@/lib/trading/safe-exit-plan-business-logic';
import { buildMarketReduceOnlyClose } from '@/lib/trading/safe-exit-business-logic';
import { upsertSafeExitPlan } from '@/lib/cockpit/safe-exit-plan-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const sessionId = requireString(args, 'session');
  const coin = requireString(args, 'coin').toUpperCase();
  const entryArg = optionalNumber(args, 'entry', 0);
  const stopPx = typeof args['stop'] === 'string' ? Number(args['stop']) : undefined;

  const position = await loadPosition(sessionId, coin);
  if (!position || position.side === 'flat' || position.sz <= 0) {
    header('No open position');
    line(`No open ${coin} position in session ${sessionId} — nothing to arm.`);
    return;
  }

  header(`refresh-exit — ${coin} ${position.side} ${position.sz} @ $${position.avgEntryPx} (re-arming Safe-Exit)`);
  line('Fetching live l2 book + running the health engine (read-only)…');

  const [book, health] = await Promise.all([
    fetchL2Book(coin),
    assessAndPersistHealth(sessionId, coin, {
      side: position.side,
      entryPx: entryArg || position.avgEntryPx,
      stopPx: stopPx !== undefined && Number.isFinite(stopPx) ? stopPx : undefined,
    }),
  ]);

  const plan = buildBestExitPlan(
    position,
    book,
    { score: health.score, pAdverse: health.pAdverse, alerts: health.alerts },
    { clientIntentId: randomUUID(), sessionId, now: Date.now() },
  );

  // Defensive: buildBestExitPlan returns null only for a flat/zero position
  // (already handled above). Fall back to the mechanical market close so the
  // panic button is NEVER left disarmed.
  const intent = plan?.intent ?? buildMarketReduceOnlyClose(position, { clientIntentId: randomUUID(), sessionId, now: Date.now() });
  if (!intent) {
    header('Nothing to arm');
    line('Could not build an exit intent (position became flat).');
    return;
  }
  const reasoning =
    plan?.reasoning ??
    `Mechanical market reduce-only close (fallback): health ${Math.round(health.score)}/100, P(adverse) ${(health.pAdverse * 100).toFixed(0)}%.`;

  await upsertSafeExitPlan(sessionId, intent, reasoning, false);

  header(`Safe-Exit plan refreshed (${plan?.style ?? 'market'})`);
  line(reasoning);
  line(`armed: ${intent.side.toUpperCase()} ${intent.sz} ${coin}${intent.limitPx != null ? ` @ $${intent.limitPx} (limit)` : ' (market)'} reduce-only`);
  line(`health ${Math.round(health.score)}/100  P(adverse) ${(health.pAdverse * 100).toFixed(0)}%  alerts: ${health.alerts.join(', ') || 'none'}`);

  await writeAnalysisLog({
    sessionId,
    source: 'refresh-exit',
    message: `Safe-Exit re-armed (${plan?.style ?? 'market'}): ${reasoning}`,
    severity: health.alerts.length ? 'warn' : 'info',
  });
});
