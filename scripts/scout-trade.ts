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
 *           --thesis "…" [--entry 1720] [--limit 1719] [--leverage 3] [--session <id>] \
 *           [--lane vault|carry|directional]   (default 'directional')
 * Exit:   pnpm scout:trade --exit --session <id> --coin ETH [--hypothesis <id>] \
 *           [--fraction 0.5] [--note "target hit"]
 */

import { randomUUID } from 'node:crypto';
import { parseArgs, requireString, optionalNumber, header, line, run } from './_skill-runtime';
import { getTradingMode } from '@/lib/env/mode';
import { assertScoutPaperMode } from '@/lib/scout/scout-execution-guard';
import { parseScoutDecision } from '@/lib/scout/scout-cycle-business-logic';
import { checkCircuitBreaker } from '@/lib/risk/circuit-breaker-service';
import { buildOpenProposal } from '@/lib/skills/open-position-business-logic';
import { buildMarketReduceOnlyClose } from '@/lib/trading/safe-exit-business-logic';
import { executeIntent } from '@/lib/trading/fill-source';
import { openSession, listActiveSessions } from '@/lib/cockpit/session-service';
import { loadPosition } from '@/lib/cockpit/fill-persistence-service';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { validateEnv } from '@/lib/env/env';
import { writeHypothesis, resolveHypothesis } from '@/lib/cockpit/hypothesis-service';
import { isDiscordConfigured } from '@/lib/infrastructure/notify/discord-notify';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { ensureWatchDaemon } from '@/lib/cockpit/watch-spawn';
import { setAdvisoryStop } from '@/lib/scout/scout-watch-service';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import type { OrderSide } from '@/types/fill';

const SCOUT_TITLE = 'scout';

async function runEntry(args: Record<string, string | boolean>): Promise<void> {
  // ACCOUNT-LEVEL CIRCUIT BREAKER: refuse a new open when the daily-loss or
  // drawdown halt is tripped. Exits are NOT gated (you can always reduce/close).
  const breaker = await checkCircuitBreaker('scout');
  if (breaker.blockNewEntries) {
    header('⛔ CIRCUIT BREAKER — new entries halted');
    line(`${breaker.reason}`);
    line(`equity=$${breaker.equityUsd.toFixed(0)} peak=$${breaker.peakEquityUsd.toFixed(0)} dayStart=$${breaker.dayStartEquityUsd.toFixed(0)}`);
    if (breaker.flattenRecommended) line('FLATTEN RECOMMENDED — review open positions for a safe exit (breaker never auto-fires).');
    return; // no new position
  }

  const coin = requireString(args, 'coin').toUpperCase();
  const sideRaw = requireString(args, 'side').toLowerCase();
  if (sideRaw !== 'buy' && sideRaw !== 'sell') throw new Error('--side must be buy or sell');
  const side = sideRaw as OrderSide;
  const thesis = requireString(args, 'thesis');
  let entryPx = optionalNumber(args, 'entry', NaN);
  // No --entry → size against the LIVE mark (uncached). Previously a missing entry
  // slipped past the NaN-blind guard and sized against safeEntry=$1 — the headless
  // $5M-notional bug. Fetch failure leaves NaN, which the proposal now REFUSES.
  if (!Number.isFinite(entryPx)) {
    try {
      const mids = await fetchAllMids(validateEnv().HL_NETWORK, { uncached: true });
      const mid = mids[coin];
      if (Number.isFinite(mid) && mid > 0) { entryPx = mid; line(`(no --entry — sized against live mark $${mid})`); }
    } catch { /* leave NaN → proposal warning refuses */ }
  }
  const riskUsd = optionalNumber(args, 'risk', NaN);
  const stopDistanceFrac = optionalNumber(args, 'stop-frac', NaN);
  const limitPx = typeof args['limit'] === 'string' ? Number(args['limit']) : undefined;
  const leverage = typeof args['leverage'] === 'string' ? Number(args['leverage']) : undefined;
  // Strategy lane (scout multi-lane): tags the positions row so the per-lane
  // scorecard groups one paper book. Default 'directional' (the legacy lane).
  const lane = typeof args['lane'] === 'string' && args['lane'].trim() !== '' ? args['lane'].trim() : 'directional';

  // Reuse the scout session or open one (dedicated, paper).
  let sessionId: string;
  if (typeof args['session'] === 'string') {
    sessionId = args['session'];
    await assertPaperSession(sessionId);
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

  const fill = await executeIntent({
    ...proposal.intent,
    origin: 'scout',
    lane,
    decisionPx: Number.isFinite(entryPx) ? entryPx : undefined, // favorable-selection clamp
  });
  if (fill.source !== 'paper') throw new Error(`expected a paper fill, got source=${fill.source}`);
  line(`Filled (paper): ${fill.sz} ${fill.coin} @ $${fill.px} (fee=$${fill.feeUsd.toFixed(4)})`);
  // The fill is COMMITTED — mark the trial-ledger row executed NOW (review F5): any
  // later bookkeeping throw must not leave a real fill ledgered as non-executed.
  await markPendingDecisionExecuted(sessionId).catch(() => {});

  // Persist the ADVISORY stop (migration 0033) so the trigger daemon's
  // position-near-stop detector has a real level to watch. UNCONDITIONAL write:
  // the scout reuses one session, so a re-entry must overwrite (or null out) any
  // stale stop a prior trade left on this (session, coin) row. Best-effort: the
  // fill is committed; a failed metadata write must not fail the trade.
  const advisoryStop = Number.isFinite(proposal.stopPx) && proposal.stopPx > 0 ? proposal.stopPx : null;
  const ok = await setAdvisoryStop(sessionId, coin, advisoryStop).catch(() => false);
  if (!ok) line('WARN: advisory stop not persisted — near-stop trigger will be silent for this position.');

  const hypothesis = await writeHypothesis({
    sessionId,
    statement: thesis,
    lane,
    coin, // (session, coin) lets a close resolve this hypothesis even if the id isn't threaded through
    // Structured trial fields (Jul-16 review): risk at open makes realized R
    // computable at close; setupType/regime make per-setup expectancy queryable.
    riskUsd: Number.isFinite(riskUsd) ? riskUsd : undefined,
    setupType: typeof args['setup-type'] === 'string' ? String(args['setup-type']) : undefined,
    regime: typeof args['regime'] === 'string' ? String(args['regime']) : undefined,
  });
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

/**
 * HARD LANE BOUNDARY: the scout may only execute against a PAPER session it owns.
 * A paper fill written into a LIVE session's ledger doesn't move money, but it
 * corrupts the live position row (the Jul-14 incident: a scout "close" flattened
 * the live HYPE row while the exchange still held the position). Fail loudly.
 */
async function assertPaperSession(sessionId: string): Promise<void> {
  const sessions = await listActiveSessions();
  const target = sessions.find((s) => s.id === sessionId);
  if (!target) throw new Error(`scout: session ${sessionId} is not an ACTIVE session — refusing`);
  if (target.mode !== 'paper') throw new Error(`scout: session ${sessionId} is mode='${target.mode}' — the scout may only touch PAPER sessions`);
}

async function runExit(args: Record<string, string | boolean>): Promise<void> {
  const sessionId = requireString(args, 'session');
  await assertPaperSession(sessionId);
  const coin = requireString(args, 'coin').toUpperCase();
  let hypothesisId = typeof args['hypothesis'] === 'string' ? args['hypothesis'] : null;
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

  // The fill is COMMITTED here — mark the trial-ledger row executed NOW, before any
  // later bookkeeping write can throw and leave a real fill ledgered as non-executed
  // (review F5). Best-effort.
  await markPendingDecisionExecuted(sessionId).catch(() => {});

  // Full close ⇒ the advisory stop no longer describes anything — clear it so the
  // near-stop trigger can't fire on a flat position. Partial closes keep it.
  const closedAll = fraction >= 1 || fill.sz >= position.sz - 1e-12;
  if (closedAll) await setAdvisoryStop(sessionId, coin, null).catch(() => false);

  // Resolution robustness (Jul-22 fix): the model often closes WITHOUT echoing the
  // hypothesisId, which orphaned the hypothesis (a HYPE reversion loss never
  // resolved → missing from per-setup expectancy). On a full close, look up the
  // OPEN hypothesis for (session, coin) so the outcome is always recorded.
  if (!hypothesisId && closedAll) {
    try {
      const db = getServiceRoleClient();
      const { data } = await db
        .from('hypotheses')
        .select('id')
        .eq('session_id', sessionId)
        .eq('coin', coin)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) hypothesisId = String((data as { id: string }).id);
    } catch { /* best-effort — resolution just skipped if the lookup fails */ }
  }

  if (hypothesisId && !closedAll) {
    // Partial close: the hypothesis stays OPEN — resolving it here would record a
    // fraction's P&L as the whole outcome and a later full close would overwrite it
    // (review F3). The final close resolves with the full-position economics folded
    // into the positions row.
    line(`Partial close (${(fraction * 100).toFixed(0)}%) — hypothesis ${hypothesisId} stays open until the final close.`);
  }
  if (hypothesisId && closedAll) {
    // Resolve the thesis by OUTCOME so the scout's win/loss record is REAL — not a
    // flat "resolved" for every close (which pinned W/L at 0/0 and win-rate blank on
    // the panel). Net realized P&L on the closed portion: dir*(exit−entry)*sz − fee.
    const dir = position.side === 'long' ? 1 : -1;
    const netPnl = dir * (fill.px - position.avgEntryPx) * fill.sz - fill.feeUsd;
    const status = netPnl > 0 ? 'confirmed' : netPnl < 0 ? 'invalidated' : 'resolved';
    const pnlLabel = `${netPnl >= 0 ? '+' : '-'}$${Math.abs(netPnl).toFixed(2)}`;
    // Realized R = net P&L / risk taken at open (null when the open predates the
    // structured fields — R stays uncomputable for legacy rows, never guessed).
    let realizedR: number | undefined;
    try {
      const db = getServiceRoleClient();
      const { data: hrow } = await db.from('hypotheses').select('risk_usd').eq('id', hypothesisId).maybeSingle();
      const riskAtOpen = Number((hrow as { risk_usd: number | null } | null)?.risk_usd);
      if (Number.isFinite(riskAtOpen) && riskAtOpen > 0) realizedR = netPnl / riskAtOpen;
    } catch { /* best-effort */ }
    await resolveHypothesis({
      hypothesisId,
      status,
      resolutionNote: `${note ?? `scout closed ${coin}`} · realized ${pnlLabel}`,
      realizedPnlUsd: netPnl,
      realizedR,
    });
    line(`Resolved hypothesis ${hypothesisId} → ${status} (realized ${pnlLabel}).`);
  }
  await writeAnalysisLog({
    sessionId,
    source: 'scout',
    message: `SCOUT closed ${fill.sz} ${coin} @ $${fill.px} (paper).${note ? ` ${note}` : ''}`,
  });
}


/** The from-json decision row awaiting an execution confirmation (module-scoped:
 *  runEntry/runExit mark it executed only when they reach their success tail). */
let pendingDecisionId: string | null = null;

/** Flip the pending trial-ledger row to executed + attach the session, called the
 *  moment the fill COMMITS (never before executeIntent, so a guard-refused open
 *  never gets marked; never after later bookkeeping, so a bookkeeping throw can't
 *  leave a real fill ledgered as non-executed — review F5/F10). */
async function markPendingDecisionExecuted(sessionId: string): Promise<void> {
  if (!pendingDecisionId) return;
  const id = pendingDecisionId;
  pendingDecisionId = null;
  await getServiceRoleClient().from('scout_decisions').update({ executed: true, session_id: sessionId }).eq('id', id);
}

/** Persist one headless decision into the scout_decisions trial ledger (append-only,
 *  informational). `executed:false` at write — flipped by markPendingDecisionExecuted
 *  only if execution actually happened, so a guard-refused open stays honest. */
async function recordScoutDecision(
  parsed: ReturnType<typeof parseScoutDecision>,
): Promise<void> {
  const db = getServiceRoleClient();
  const row: { kind: string; coin?: string | null; lane?: string | null; reasoning: string } =
    parsed.kind === 'error'
      ? { kind: 'error', reasoning: parsed.error.slice(0, 2000) }
      : parsed.kind === 'stand-down'
        ? { kind: 'stand-down', reasoning: parsed.note.slice(0, 2000) }
        : parsed.kind === 'propose'
          ? { kind: 'propose', coin: parsed.coin, reasoning: `${parsed.title} — ${parsed.body}`.slice(0, 2000) }
          : {
              kind: parsed.kind,
              coin: typeof parsed.args['coin'] === 'string' ? String(parsed.args['coin']).toUpperCase() : null,
              lane: typeof parsed.args['lane'] === 'string' ? String(parsed.args['lane']) : null,
              reasoning: String(parsed.args['thesis'] ?? parsed.args['note'] ?? '').slice(0, 2000),
            };
  const { data } = await db.from('scout_decisions').insert(row).select('id').maybeSingle();
  if ((parsed.kind === 'open' || parsed.kind === 'close') && data) {
    pendingDecisionId = String((data as { id: string }).id);
  }
}

run(async () => {
  let args = parseArgs(process.argv.slice(2));

  // HARD SAFETY BOUNDARY: the scout's popup-less execution is paper-only. This
  // throws in live mode — real-money trades must go through the human approval
  // popup (Tier-1), never this autonomous path.
  assertScoutPaperMode(getTradingMode());

  // Headless contract (C2): --from-json '<decision>' carries the model's decision as
  // ONE strict JSON object (see parseScoutDecision — malformed NEVER trades). The
  // stand-down outcome is first-class: log it and exit clean.
  if (typeof args['from-json'] === 'string') {
    const parsed = parseScoutDecision(args['from-json']);
    // TRIAL LEDGER (Jul-16 review): persist EVERY decision — including stand-downs
    // and parse errors. Stand-downs are trials; an unlogged search makes the track
    // record uninterpretable (Bailey/López de Prado). Best-effort: ledger failure
    // must never block or fail the decision path.
    await recordScoutDecision(parsed).catch(() => {});
    if (parsed.kind === 'error') {
      header('⛔ headless decision REJECTED');
      line(parsed.error);
      process.exitCode = 1;
      return;
    }
    if (parsed.kind === 'stand-down') {
      header('stand-down');
      line(parsed.note);
      return;
    }
    if (parsed.kind === 'propose') {
      // STEWARD proposal: page + log, NEVER execute. The operator (or the main desk
      // agent) drafts/amends the actual ladder per docs/LADDER_BUILDER_GUIDE.md.
      header('💡 STEWARD PROPOSAL (no execution)');
      line(parsed.title);
      line(parsed.body);
      // Mechanical rate-limit (review F3): the same title within 2h is a repeat — a
      // stuck model must not page every cron cycle. Evidence-strengthened proposals
      // should carry a NEW title (the playbook says so).
      let isRepeat = false;
      try {
        const db = getServiceRoleClient();
        const { data } = await db
          .from('analysis_log')
          .select('id')
          .eq('source', 'scout')
          .ilike('message', `STEWARD PROPOSAL%${parsed.title.slice(0, 60)}%`)
          .gte('created_at', new Date(Date.now() - 2 * 3_600_000).toISOString())
          .limit(1);
        isRepeat = (data?.length ?? 0) > 0;
      } catch { /* dedupe unavailable → page anyway (fail-open for an advisory) */ }
      if (isRepeat) {
        line('(repeat within 2h — logged, not paged)');
        return;
      }
      if (!isDiscordConfigured()) {
        // Jul-16 review: an unconfigured webhook silently ate proposals. Be LOUD —
        // the whole steward lane is decorative if this env is missing in the cron.
        line('⚠ DISCORD_WEBHOOK_URL not set in this environment — proposal logged but NOT paged.');
        try {
          const db = getServiceRoleClient();
          const { data: sess } = await db.from('sessions').select('id').eq('status', 'active').order('created_at', { ascending: false }).limit(1);
          const sid = (sess?.[0] as { id: string } | undefined)?.id;
          if (sid) await writeAnalysisLog({ sessionId: sid, source: 'scout', severity: 'warn', message: 'STEWARD PROPOSAL DROPPED FROM DISCORD — DISCORD_WEBHOOK_URL is not exported in the scout cron env.' });
        } catch { /* best-effort */ }
      }
      // COUNTERFACTUAL LEDGER (Jul-17): freeze the market state so the resolver can
      // later answer "would acting on this have helped?" even if the operator slept
      // through it. Read-only reads; a failed freeze still pages (advisory first).
      try {
        const db = getServiceRoleClient();
        let side: 'long' | 'short' | null = null;
        let positionSz: number | null = null;
        let markPx: number | null = null;
        if (parsed.coin) {
          const { fetchAllMids, fetchClearinghouseState } = await import('@/lib/hyperliquid/hyperliquid-info-service');
          const { getHlAccountAddress } = await import('@/lib/auto-exit/auto-exit-config');
          const mids = await fetchAllMids().catch(() => ({}) as Record<string, string>);
          markPx = Number.isFinite(Number(mids[parsed.coin])) ? Number(mids[parsed.coin]) : null;
          const addr = getHlAccountAddress();
          const ch = addr ? await fetchClearinghouseState(addr).catch(() => null) : null;
          const pos = (ch?.positions ?? []).find((x) => x.coin.toUpperCase() === parsed.coin && x.size > 0);
          if (pos) { side = pos.side === 'short' ? 'short' : 'long'; positionSz = pos.size; }
        }
        await db.from('steward_proposals').insert({
          coin: parsed.coin ?? '?',
          title: parsed.title,
          body: parsed.body,
          proposal_kind: parsed.proposalKind,
          side,
          position_sz: positionSz,
          mark_px: markPx,
          param_px: parsed.paramPx,
          horizon_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        });
        line(`(counterfactual ledger: ${parsed.proposalKind}${parsed.paramPx ? ` @ ${parsed.paramPx}` : ''}, mark ${markPx ?? '?'}, ${side ?? 'no position'})`);
      } catch (e) {
        line(`WARN: proposal not ledgered: ${e instanceof Error ? e.message : String(e)}`);
      }
      await sendDiscord(`💡 **STEWARD PROPOSAL**${parsed.coin ? ` [${parsed.coin}]` : ''} — ${parsed.title} (${parsed.proposalKind}${parsed.paramPx ? ` @ ${parsed.paramPx}` : ''})
${parsed.body}
_(advisory only — nothing was executed; the counterfactual resolver will score this within 24h)_`, 'HL Ladder Steward').catch(() => {});
      try {
        const db = getServiceRoleClient();
        const { data: sess } = await db.from('sessions').select('id').eq('status', 'active').order('created_at', { ascending: false }).limit(1);
        const sid = (sess?.[0] as { id: string } | undefined)?.id;
        if (sid) await writeAnalysisLog({ sessionId: sid, source: 'scout', severity: 'info', message: `STEWARD PROPOSAL${parsed.coin ? ` [${parsed.coin}]` : ''}: ${parsed.title} — ${parsed.body.slice(0, 300)}` });
      } catch { /* best-effort */ }
      return;
    }
    args = parsed.args;
  }

  const isExit = args['exit'] === true || args['exit'] === 'true';
  if (isExit) {
    await runExit(args);
  } else {
    await runEntry(args);
  }
});
