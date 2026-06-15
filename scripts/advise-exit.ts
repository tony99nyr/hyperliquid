/**
 * skill:advise-exit entrypoint (thin I/O). ACTION skill.
 *
 * HARD PRINCIPLE: this NEVER auto-fires. It loads the open position, runs the
 * health engine, builds a recommended exit (full/partial) + the reduce-only
 * TradeIntent via the PURE recommender, surfaces it, and REQUIRES EXPLICIT user
 * confirmation before calling executeIntent. On confirm it executes the
 * reduce-only order, then resolves the hypothesis (confirmed when the exit booked
 * a profit, invalidated otherwise).
 *
 * Usage:
 *   pnpm skill:advise-exit --session <id> --coin ETH --entry 2000 \
 *     --hypothesis <id> [--stop 1900] [--confirm yes]
 */

import { randomUUID } from 'node:crypto';
import { parseArgs, requireString, optionalNumber, requireConfirmation, header, line, run } from './_skill-runtime';
import { getTradingMode } from '@/lib/env/mode';
import { loadPosition } from '@/lib/cockpit/fill-persistence-service';
import { assessAndPersistHealth } from '@/lib/health/health-engine';
import { buildExitProposal } from '@/lib/skills/advise-exit-business-logic';
import { executeIntent } from '@/lib/trading/fill-source';
import { resolveHypothesis } from '@/lib/cockpit/hypothesis-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const mode = getTradingMode();
  const sessionId = requireString(args, 'session');
  const coin = requireString(args, 'coin').toUpperCase();
  const entryPx = optionalNumber(args, 'entry', 0);
  const stopPx = typeof args['stop'] === 'string' ? Number(args['stop']) : undefined;
  const hypothesisId = typeof args['hypothesis'] === 'string' ? args['hypothesis'] : null;

  const position = await loadPosition(sessionId, coin);
  if (!position || position.side === 'flat' || position.sz <= 0) {
    header('No open position');
    line(`No open ${coin} position in session ${sessionId} — nothing to exit.`);
    return;
  }

  header(`advise-exit — ${coin} ${position.side} ${position.sz} @ $${position.avgEntryPx} (mode=${mode})`);
  line('Running the health engine (read-only)…');
  const health = await assessAndPersistHealth(sessionId, coin, {
    side: position.side,
    entryPx: entryPx || position.avgEntryPx,
    stopPx: stopPx !== undefined && Number.isFinite(stopPx) ? stopPx : undefined,
  });

  const proposal = buildExitProposal(position, health, { clientIntentId: randomUUID(), now: Date.now() });

  header(`Exit recommendation: ${proposal.kind.toUpperCase()}`);
  line(proposal.reason);
  line(`health ${Math.round(health.score)}/100  P(adverse) ${(health.pAdverse * 100).toFixed(0)}%  alerts: ${health.alerts.join(', ') || 'none'}`);

  if (proposal.kind === 'none' || !proposal.intent) {
    await writeAnalysisLog({
      sessionId,
      source: 'advise-exit',
      message: `No exit advised for ${coin}: ${proposal.reason}`,
    });
    header('No exit advised — holding');
    return;
  }

  const intent = { ...proposal.intent, sessionId };
  const confirmed = await requireConfirmation(
    args,
    `Execute reduce-only ${intent.side.toUpperCase()} ${intent.sz} ${coin} (${proposal.kind} exit)\n(mode=${mode} — ${mode === 'live' ? 'REAL ORDER' : 'paper fill from live book'})`,
  );
  if (!confirmed) {
    header('Aborted — no order placed');
    line('The user did not confirm. Position unchanged.');
    return;
  }

  header('Executing reduce-only exit (confirmed by user)…');
  const fill = await executeIntent(intent);
  line(`Filled: ${fill.sz} ${fill.coin} @ $${fill.px} (source=${fill.source}, fee=$${fill.feeUsd.toFixed(4)})`);

  // Resolve the hypothesis on a FULL exit (a partial keeps the thesis open).
  if (hypothesisId && proposal.kind === 'full') {
    // Did the closed leg book a gain vs the recorded avg entry?
    const dir = position.side === 'long' ? 1 : -1;
    const realized = dir * (fill.px - position.avgEntryPx) * fill.sz;
    const status = realized >= 0 ? 'confirmed' : 'invalidated';
    await resolveHypothesis({
      hypothesisId,
      status,
      resolutionNote: `Full exit @ $${fill.px}; realized ~$${realized.toFixed(2)} on the closed leg.`,
    });
    header(`Hypothesis ${status}`);
  }

  await writeAnalysisLog({
    sessionId,
    source: 'advise-exit',
    message: `${proposal.kind} exit: ${intent.side} ${fill.sz} ${coin} @ $${fill.px} (${fill.source}).`,
    severity: 'warn',
  });
  header('Exit executed');
  line('Re-run assess-trade-health if a runner remains.');
});
