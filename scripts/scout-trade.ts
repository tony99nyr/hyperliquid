/**
 * pnpm scout:trade — the autonomous scout's PAPER execution path (thin I/O).
 *
 * This is the ONE place that executes WITHOUT a human approval popup — allowed
 * for PAPER only, hard-guarded by `assertScoutPaperMode`. It reuses the exact
 * same pure builders + `executeIntent` seam as the human skills; it just skips
 * the popup because autonomous paper vetting is the whole point. Live trades the
 * scout likes are surfaced to the human and go through `open-position`/`run-session`
 * (the popup) — NEVER this script.
 *
 * Entry:  pnpm scout:trade --coin ETH --side sell --risk 200 --stop-frac 0.02 \
 *           --thesis "…" [--entry 1720] [--limit 1719] [--leverage 3] [--session <id>]
 * Exit:   pnpm scout:trade --exit --session <id> --coin ETH [--hypothesis <id>] \
 *           [--fraction 0.5] [--note "target hit"]
 */

import { randomUUID } from 'node:crypto';
import { parseArgs, requireString, optionalNumber, header, line, run } from './_skill-runtime';
import { getTradingMode } from '@/lib/env/mode';
import { assertScoutPaperMode } from '@/lib/scout/scout-execution-guard';
import { buildOpenProposal } from '@/lib/skills/open-position-business-logic';
import { buildMarketReduceOnlyClose } from '@/lib/trading/safe-exit-business-logic';
import { executeIntent } from '@/lib/trading/fill-source';
import { openSession } from '@/lib/cockpit/session-service';
import { loadPosition } from '@/lib/cockpit/fill-persistence-service';
import { writeHypothesis, resolveHypothesis } from '@/lib/cockpit/hypothesis-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { ensureWatchDaemon } from '@/lib/cockpit/watch-spawn';
import type { OrderSide } from '@/types/fill';

const SCOUT_TITLE = 'scout';

async function runEntry(args: Record<string, string | boolean>): Promise<void> {
  const coin = requireString(args, 'coin').toUpperCase();
  const sideRaw = requireString(args, 'side').toLowerCase();
  if (sideRaw !== 'buy' && sideRaw !== 'sell') throw new Error('--side must be buy or sell');
  const side = sideRaw as OrderSide;
  const thesis = requireString(args, 'thesis');
  const entryPx = optionalNumber(args, 'entry', NaN);
  const riskUsd = optionalNumber(args, 'risk', NaN);
  const stopDistanceFrac = optionalNumber(args, 'stop-frac', NaN);
  const limitPx = typeof args['limit'] === 'string' ? Number(args['limit']) : undefined;
  const leverage = typeof args['leverage'] === 'string' ? Number(args['leverage']) : undefined;

  // Reuse the scout session or open one (dedicated, paper).
  let sessionId: string;
  if (typeof args['session'] === 'string') {
    sessionId = args['session'];
  } else {
    const s = await openSession({ mode: 'paper', title: SCOUT_TITLE, leaderAddress: null });
    sessionId = s.id;
    line(`Opened scout session ${sessionId} (paper).`);
  }

  const proposal = buildOpenProposal({
    sessionId,
    coin,
    side,
    entryPx,
    riskUsd,
    stopDistanceFrac,
    limitPx: limitPx !== undefined && Number.isFinite(limitPx) ? limitPx : undefined,
    leverage: leverage !== undefined && Number.isFinite(leverage) ? leverage : undefined,
    clientIntentId: randomUUID(),
    now: Date.now(),
    thesis,
  });

  header('scout:trade ENTRY (paper, autonomous)');
  line(proposal.rationale);
  const entryLabel = Number.isFinite(entryPx) ? `$${entryPx}` : 'market';
  line(`entry≈${entryLabel}  stop=$${proposal.stopPx}  size=${proposal.intent.sz}  notional=$${proposal.notionalUsd}  risk=$${proposal.dollarRisk}`);
  if (proposal.warnings.length > 0) {
    header('WARNINGS — refusing to execute');
    proposal.warnings.forEach((w) => line(`- ${w}`));
    throw new Error('Proposal has warnings; fix the inputs and retry.');
  }

  const fill = await executeIntent({ ...proposal.intent, origin: 'scout' });
  if (fill.source !== 'paper') throw new Error(`expected a paper fill, got source=${fill.source}`);
  line(`Filled (paper): ${fill.sz} ${fill.coin} @ $${fill.px} (fee=$${fill.feeUsd.toFixed(4)})`);

  const hypothesis = await writeHypothesis({ sessionId, statement: thesis });
  await writeAnalysisLog({
    sessionId,
    source: 'scout',
    message: `SCOUT opened ${side} ${fill.sz} ${coin} @ $${fill.px} (paper). Thesis: ${thesis}`,
  });
  header('Paper position opened + hypothesis recorded');
  line(`session: ${sessionId}`);
  line(`hypothesis id: ${hypothesis.id}`);

  // Bring up the crash-safe watch daemon so the position is monitored even if the
  // scout session dies. Never fail the (committed) paper fill if it can't start.
  try {
    const watch = ensureWatchDaemon(20);
    line(watch.status === 'spawned' ? `Monitoring started (pid ${watch.pid ?? '?'}).` : 'Monitoring already running.');
  } catch (err) {
    line(`WARN: watch daemon not started (${err instanceof Error ? err.message : String(err)}). Run \`pnpm watch\`.`);
  }
}

async function runExit(args: Record<string, string | boolean>): Promise<void> {
  const sessionId = requireString(args, 'session');
  const coin = requireString(args, 'coin').toUpperCase();
  const hypothesisId = typeof args['hypothesis'] === 'string' ? args['hypothesis'] : null;
  const note = typeof args['note'] === 'string' ? args['note'] : null;
  const fraction = optionalNumber(args, 'fraction', 1);

  const position = await loadPosition(sessionId, coin);
  if (!position || position.side === 'flat' || position.sz <= 0) {
    header('Nothing to close');
    line(`No open ${coin} position in session ${sessionId}.`);
    return;
  }

  const intent = buildMarketReduceOnlyClose(position, {
    clientIntentId: randomUUID(),
    sessionId,
    now: Date.now(),
    fraction: fraction > 0 && fraction <= 1 ? fraction : 1,
  });
  if (!intent) {
    header('Nothing to close');
    line('Close builder returned null (position likely flat).');
    return;
  }

  header('scout:trade EXIT (paper, autonomous reduce-only)');
  const fill = await executeIntent({ ...intent, origin: 'scout' });
  if (fill.source !== 'paper') throw new Error(`expected a paper fill, got source=${fill.source}`);
  line(`Closed (paper): ${fill.sz} ${fill.coin} @ $${fill.px} (fee=$${fill.feeUsd.toFixed(4)})`);

  if (hypothesisId) {
    await resolveHypothesis({ hypothesisId, status: 'resolved', resolutionNote: note ?? `scout closed ${coin}` });
    line(`Resolved hypothesis ${hypothesisId}.`);
  }
  await writeAnalysisLog({
    sessionId,
    source: 'scout',
    message: `SCOUT closed ${fill.sz} ${coin} @ $${fill.px} (paper).${note ? ` ${note}` : ''}`,
  });
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));

  // HARD SAFETY BOUNDARY: the scout's popup-less execution is paper-only. This
  // throws in live mode — real-money trades must go through the human approval
  // popup (Tier-1), never this autonomous path.
  assertScoutPaperMode(getTradingMode());

  const isExit = args['exit'] === true || args['exit'] === 'true';
  if (isExit) {
    await runExit(args);
  } else {
    await runEntry(args);
  }
});
