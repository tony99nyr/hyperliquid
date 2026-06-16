/**
 * skill:open-position entrypoint (thin I/O). ACTION skill.
 *
 * HARD PRINCIPLE: this NEVER auto-fires. It builds the proposed TradeIntent
 * (risk-based size + stop + rationale) via the PURE builder, surfaces it, and
 * REQUIRES EXPLICIT user confirmation before calling executeIntent. On confirm
 * it executes (paper now / live later — mode-transparent), then writes the
 * hypothesis (the thesis). The session row is created by open-session before this
 * (pass --session), or created here when --create-session is given.
 *
 * Usage:
 *   pnpm skill:open-position --session <id> --coin ETH --side buy \
 *     --entry 2000 --risk 100 --stop-frac 0.05 --thesis "…" [--limit 1995] [--confirm yes]
 */

import { randomUUID } from 'node:crypto';
import { parseArgs, requireString, optionalNumber, requireConfirmation, header, line, run } from './_skill-runtime';
import { getTradingMode } from '@/lib/env/mode';
import { buildOpenProposal } from '@/lib/skills/open-position-business-logic';
import { executeIntent } from '@/lib/trading/fill-source';
import { openSession } from '@/lib/cockpit/session-service';
import { writeHypothesis } from '@/lib/cockpit/hypothesis-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import type { OrderSide } from '@/types/fill';

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const mode = getTradingMode();

  const coin = requireString(args, 'coin').toUpperCase();
  const sideRaw = requireString(args, 'side').toLowerCase();
  if (sideRaw !== 'buy' && sideRaw !== 'sell') throw new Error('--side must be buy or sell');
  const side = sideRaw as OrderSide;
  const thesis = requireString(args, 'thesis');
  const entryPx = optionalNumber(args, 'entry', NaN);
  const riskUsd = optionalNumber(args, 'risk', NaN);
  const stopDistanceFrac = optionalNumber(args, 'stop-frac', NaN);
  const limitPx = typeof args['limit'] === 'string' ? Number(args['limit']) : undefined;

  // Session: reuse --session or create one.
  let sessionId: string;
  if (typeof args['session'] === 'string') {
    sessionId = args['session'];
  } else {
    const s = await openSession({ mode, title: `${coin} ${side}`, leaderAddress: null });
    sessionId = s.id;
    line(`Opened session ${sessionId} (mode=${mode}).`);
  }

  const proposal = buildOpenProposal({
    sessionId,
    coin,
    side,
    entryPx,
    riskUsd,
    stopDistanceFrac,
    limitPx: limitPx !== undefined && Number.isFinite(limitPx) ? limitPx : undefined,
    clientIntentId: randomUUID(),
    now: Date.now(),
    thesis,
  });

  header(`open-position PROPOSAL (mode=${mode})`);
  line(proposal.rationale);
  line(`entry≈$${entryPx}  stop=$${proposal.stopPx}  size=${proposal.intent.sz}  notional=$${proposal.notionalUsd}  risk=$${proposal.dollarRisk}`);

  if (proposal.warnings.length > 0) {
    header('WARNINGS — refusing to execute');
    proposal.warnings.forEach((w) => line(`- ${w}`));
    throw new Error('Proposal has warnings; fix the inputs and retry.');
  }

  const confirmed = await requireConfirmation(
    args,
    `Execute: ${proposal.rationale}\n(mode=${mode} — ${mode === 'live' ? 'REAL ORDER' : 'paper fill from live book'})`,
    { mode, liveConfirmPhrase: `${side} ${proposal.intent.sz} ${coin}` },
  );
  if (!confirmed) {
    header('Aborted — no order placed');
    line('The user did not confirm. Nothing executed.');
    return;
  }

  header('Executing intent (confirmed by user)…');
  const fill = await executeIntent(proposal.intent);
  line(`Filled: ${fill.sz} ${fill.coin} @ $${fill.px} (source=${fill.source}, fee=$${fill.feeUsd.toFixed(4)})`);

  const hypothesis = await writeHypothesis({ sessionId, statement: thesis });
  await writeAnalysisLog({
    sessionId,
    source: 'open-position',
    message: `Opened ${side} ${fill.sz} ${coin} @ $${fill.px} (${fill.source}). Thesis: ${thesis}`,
  });
  header('Position opened + hypothesis recorded');
  line(`hypothesis id: ${hypothesis.id}`);
  line('Run assess-trade-health to monitor it.');
});
