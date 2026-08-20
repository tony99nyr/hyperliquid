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
 *           --thesis "…" --lane <lane> [--entry 1720] [--limit 1719] [--leverage 3] [--session <id>]
 *         --lane is REQUIRED (killed lanes are refused by assertLaneAlive; the old
 *         default 'directional' is killed). Live: htf-trend | compression-straddle |
 *         breakdown-short | reclaim-long | leader-follow | vault | carry.
 * Exit:   pnpm scout:trade --exit --session <id> --coin ETH [--hypothesis <id>] \
 *           [--fraction 0.5] [--note "target hit"]
 */

import { randomUUID } from 'node:crypto';
import { parseArgs, requireString, optionalNumber, header, line, run } from './_skill-runtime';
import { getTradingMode } from '@/lib/env/mode';
import { assertScoutPaperMode, assertLaneAlive } from '@/lib/scout/scout-execution-guard';
import { parseScoutDecision } from '@/lib/scout/scout-cycle-business-logic';
import { checkCircuitBreaker } from '@/lib/risk/circuit-breaker-service';
import { buildOpenProposal } from '@/lib/skills/open-position-business-logic';
import { buildMarketReduceOnlyClose } from '@/lib/trading/safe-exit-business-logic';
import { executeIntent } from '@/lib/trading/fill-source';
import { openSession, closeSession, listActiveSessions } from '@/lib/cockpit/session-service';
import { loadPosition, loadOpenPositions } from '@/lib/cockpit/fill-persistence-service';
import { fetchAllMids } from '@/lib/hyperliquid/hyperliquid-info-service';
import { validateEnv } from '@/lib/env/env';
import { writeHypothesis, resolveHypothesis } from '@/lib/cockpit/hypothesis-service';
import { isDiscordConfigured } from '@/lib/infrastructure/notify/discord-notify';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { ensureWatchDaemon } from '@/lib/cockpit/watch-spawn';
import { setAdvisoryStop, setAdvisoryTarget, writeScoutHeartbeat } from '@/lib/scout/scout-watch-service';
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
  // scorecard groups one paper book. REQUIRED since 08-13: the legacy default
  // ('directional') is a KILLED lane, so a lane-less open could only ever be refused
  // with a confusing error — demand the tag explicitly instead.
  // Normalized ONCE here (lowercase): the guard, the cooldown query, and the stored
  // positions.lane row must all see the same string — a mixed-case tag ('Leader-Follow')
  // used to pass the allowlist but dodge the cooldown's .eq() and fragment the per-lane
  // scorecard (review 08-20 M1).
  const lane = typeof args['lane'] === 'string' ? args['lane'].trim().toLowerCase() : '';
  if (lane === '') {
    throw new Error(
      "--lane is required for an open (the legacy default 'directional' is KILLED). " +
        "Live lanes: 'htf-trend', 'compression-straddle', 'breakdown-short', 'reclaim-long', 'leader-follow', 'vault', 'carry'.",
    );
  }
  // DETERMINISTIC kill-bar enforcement (08-13 review): a killed lane can NEVER open —
  // prose/context-only sections were not enough (42 trades churned past a fired bar).
  // Exits stay allowed (the --exit path below never calls this).
  assertLaneAlive(lane);
  // DETERMINISTIC entry cooldown: prose doesn't hold (leader-follow violated night one,
  // 08-17; trend-follow churned 42 trades, 08-13) — every lane whose frozen rule limits
  // re-entry gets a mechanical gate here. Any positions-row activity on this coin+lane
  // inside the window blocks a NEW open (conservative: a close also restarts the clock —
  // exactly the anti-churn intent, and for htf/compression it blocks the open→stop→
  // reopen loop while a breakout directive stays live all day; review 08-20 H1).
  // htf-trend 24h = the daily-bar cadence; compression 12h = the 3×4h grace episode.
  // NOTE (lane-boundary): the query is not sessions.mode-scoped — safe because only
  // scout paper intents carry `lane` (live rows have lane=null); if a live lane tag
  // ever exists, scope this to paper sessions. Fail-CLOSED on a read error.
  const LANE_ENTRY_COOLDOWN_HOURS: Record<string, number> = {
    'leader-follow': 24,
    'htf-trend': 24,
    'compression-straddle': 12,
  };
  const cooldownH = LANE_ENTRY_COOLDOWN_HOURS[lane];
  if (cooldownH) {
    const db = getServiceRoleClient();
    const since = new Date(Date.now() - cooldownH * 3_600_000).toISOString();
    const { data: recent, error: cdErr } = await db
      .from('positions')
      .select('updated_at')
      .eq('coin', coin)
      .eq('lane', lane)
      .gte('updated_at', since)
      .limit(1);
    if (cdErr) throw new Error(`lane-cooldown check failed (${cdErr.message}) — refusing open (fail-closed)`);
    if ((recent?.length ?? 0) > 0) {
      throw new Error(
        `lane '${lane}' cooldown: a ${coin} entry/exit already happened in the last ${cooldownH}h — ` +
          'ONE entry per coin per window (frozen pre-registration). A cluster of leader adds is ONE signal; stand down.',
      );
    }
  }

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

  // OPEN BASELINE (migration 0041): the cumulative realized/fees on this (session,
  // coin) row BEFORE this trip's open fill folds. The scout reuses one session and
  // re-enters coins, so the row's accumulators span EVERY prior trip; the close
  // resolves on (now − baseline) so a prior trip can't contaminate this one's P&L.
  // Read it here, pre-fill, so this trip's entry fee is inside the delta. Best-effort:
  // a null read leaves the baseline unset and the close falls back to single-leg.
  const priorPos = await loadPosition(sessionId, coin).catch(() => null);
  const realizedAtOpenUsd = Number.isFinite(Number(priorPos?.realizedPnlUsd)) ? Number(priorPos?.realizedPnlUsd) : 0;
  const feesAtOpenUsd = Number.isFinite(Number(priorPos?.feesPaidUsd)) ? Number(priorPos?.feesPaidUsd) : 0;

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

  // Advisory TARGET (migration 0042) — the reversion lane's MECHANICAL take-profit.
  // Persist --target so position-at-target fires + the cycle snapshot shows atTarget,
  // so the model closes at the registered target instead of holding a winner past it.
  // UNCONDITIONAL like the stop: a re-entry overwrites (or clears) any stale target.
  const targetArg = typeof args['target'] === 'string' ? Number(args['target']) : NaN;
  let advisoryTarget = Number.isFinite(targetArg) && targetArg > 0 ? targetArg : null;
  // Profit-side sanity vs the ACTUAL fill: a short's target must be BELOW entry, a
  // long's ABOVE. A wrong-side target would trip position-at-target immediately at a
  // loss (review) — drop it with a WARN rather than persist a bad level. Also the
  // audit echo below prints the level so a --target that isn't the scan's computed
  // 50%-retrace (a smuggled free parameter) is visible in the log.
  if (advisoryTarget != null) {
    const profitSide = side === 'buy' ? advisoryTarget > fill.px : advisoryTarget < fill.px; // buy=long (target above), sell=short (below)
    if (!profitSide) {
      line(`WARN: --target ${advisoryTarget} is not on the profit side of entry ${fill.px} (${side}) — ignoring.`);
      advisoryTarget = null;
    }
  }
  await setAdvisoryTarget(sessionId, coin, advisoryTarget).catch(() => false);
  if (advisoryTarget) line(`Target persisted: ${advisoryTarget} (reversion take-profit; entry ${fill.px}).`);

  // The fill is COMMITTED (line 113). writeHypothesis must NOT throw past this point
  // — a DB blip / missing column would otherwise crash out and leave a paper
  // position with no hypothesis (no outcome, unresolvable) yet the fill on the
  // books (review H1). Best-effort + LOUD: the close path's (session, coin) lookup
  // will find nothing, so warn so the tracking gap is visible, not silent.
  let hypothesis: { id: string } | null = null;
  try {
    hypothesis = await writeHypothesis({
      sessionId,
      statement: thesis,
      lane,
      coin, // (session, coin) lets a close resolve this hypothesis even if the id isn't threaded through
      // Structured trial fields (Jul-16 review): risk at open makes realized R
      // computable at close; setupType/regime make per-setup expectancy queryable.
      riskUsd: Number.isFinite(riskUsd) ? riskUsd : undefined,
      setupType: typeof args['setup-type'] === 'string' ? String(args['setup-type']) : undefined,
      regime: typeof args['regime'] === 'string' ? String(args['regime']) : undefined,
      realizedAtOpenUsd,
      feesAtOpenUsd,
    });
  } catch (err) {
    line(`WARN: hypothesis NOT recorded (${err instanceof Error ? err.message : String(err)}) — position is open but its outcome won't be tracked. Investigate.`);
  }
  // Best-effort: a logging blip here must NOT throw past the committed fill and skip
  // the watch-daemon spawn below (an unmonitored live paper position) or the caller's
  // 'scout-cycle' heartbeat (a healthy trade looking dead — review D-MED).
  await writeAnalysisLog({
    sessionId,
    source: 'scout',
    message: `SCOUT opened ${side} ${fill.sz} ${coin} @ $${fill.px} (paper). Thesis: ${thesis}`,
  }).catch(() => {});
  header('Paper position opened + hypothesis recorded');
  line(`session: ${sessionId}`);
  line(`hypothesis id: ${hypothesis?.id ?? '(not recorded — see WARN above)'}`);

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

/**
 * Resolve the session to close when the model omits --session: the (single) ACTIVE
 * PAPER session holding an open position for `coin`. Only paper sessions are searched
 * (the lane boundary — a live position is never touchable here). Refuses on zero
 * (nothing to close) or more-than-one (ambiguous — the caller must disambiguate with
 * --session), so it can never close the wrong book.
 */
async function resolveScoutPaperSessionForCoin(coin: string): Promise<string> {
  const paper = (await listActiveSessions()).filter((s) => s.mode === 'paper');
  const holding: string[] = [];
  for (const s of paper) {
    const pos = await loadPosition(s.id, coin).catch(() => null);
    if (pos && pos.side !== 'flat' && pos.sz > 0) holding.push(s.id);
  }
  if (holding.length === 0) throw new Error(`scout close: no ACTIVE paper session holds an open ${coin} position`);
  if (holding.length > 1) throw new Error(`scout close: ${holding.length} paper sessions hold ${coin} — pass --session to disambiguate`);
  return holding[0];
}

async function runExit(args: Record<string, string | boolean>): Promise<void> {
  const coin = requireString(args, 'coin').toUpperCase();
  // Session: use the explicit --session when given, else resolve the (single) active
  // PAPER session holding an open position for this coin. The headless model has the
  // coin from the snapshot but not always the session id — without this a compliant
  // close ("close SOL") errored with 'sessionId required' and never executed, so the
  // reversion target exit could never fire (found live Jul 23).
  let sessionId: string;
  if (typeof args['session'] === 'string' && args['session'].trim()) {
    sessionId = args['session'].trim();
    await assertPaperSession(sessionId);
  } else {
    sessionId = await resolveScoutPaperSessionForCoin(coin);
    line(`(no --session — resolved paper session ${sessionId} holding an open ${coin} position)`);
  }
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

  // Full close ⇒ the advisory stop + target no longer describe anything — clear both
  // so neither near-stop nor at-target fires on a flat position. Partial closes keep them.
  const closedAll = fraction >= 1 || fill.sz >= position.sz - 1e-12;
  if (closedAll) {
    await setAdvisoryStop(sessionId, coin, null).catch(() => false);
    await setAdvisoryTarget(sessionId, coin, null).catch(() => false);
  }

  // Resolution robustness (Jul-22 fix): the model often closes WITHOUT echoing the
  // hypothesisId, which orphaned the hypothesis (a HYPE reversion loss never
  // resolved → missing from per-setup expectancy). On a full close, look up the
  // OPEN hypothesis for (session, coin) so the outcome is always recorded.
  if (!hypothesisId && closedAll) {
    try {
      const db = getServiceRoleClient();
      // Resolve the OLDEST open hypothesis for (session, coin) — FIFO. The scout
      // convention is one-open-per-coin, but nothing enforces it; if a scale-in
      // ever left two open, "newest" would resolve the wrong one (the class of the
      // Jul-22 manual mix-up: a SOL winner and a HYPE loser both 'open'). FIFO pairs
      // this close with the earliest unresolved thesis and warns on the ambiguity.
      const { data } = await db
        .from('hypotheses')
        .select('id')
        .eq('session_id', sessionId)
        .eq('coin', coin)
        .eq('status', 'open')
        .order('created_at', { ascending: true })
        .limit(2);
      const rows = (data as { id: string }[] | null) ?? [];
      if (rows.length > 1) {
        // Ambiguous: ≥2 open hypotheses for one (session, coin) — off the
        // one-open-per-coin convention (usually a prior trip whose resolution failed
        // and stayed open). Each carries its OWN open baseline; auto-pairing this close
        // with either risks attributing this trip's P&L against the WRONG baseline →
        // a wrong ledger number (the corruption this whole path prevents). Leave BOTH
        // open and page for an explicit, id-scoped resolution — an orphan is
        // recoverable, a wrong number is not.
        line(`WARN: ${rows.length} open ${coin} hypotheses for this session — NOT auto-resolving (ambiguous baseline). Resolve by explicit hypothesisId; ledger left untouched.`);
      } else if (rows[0]) {
        hypothesisId = String(rows[0].id);
      }
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
    // the panel).
    //
    // THIS trip's net = the DELTA of the folded positions accumulators vs the OPEN
    // baseline (migration 0041). executeIntent folds every fill into
    // positions.realized_pnl_usd (cumulative GROSS realized) + fees_paid_usd
    // (cumulative). Those span EVERY trip on this reused (session, coin) row — reading
    // the raw cumulative would bake a PRIOR trip's P&L into this outcome (review H1),
    // while reading only the final fill drops this trip's banked partials + entry fee
    // (review C1). The delta (now − at-open) is exactly this trip's realized and fees:
    // partials in, prior trips out. Legacy rows carry no baseline → single-leg fallback
    // (exact for their full closes; on a legacy PARTIAL-then-close it counts only the
    // final leg — dropping the banked partial + entry fee — but no live open row
    // predates the baseline, so that path is transitional only).
    const dir = position.side === 'long' ? 1 : -1;
    const closed = await loadPosition(sessionId, coin).catch(() => null); // flat now; cumulative realized+fees across ALL trips
    const realizedNow = Number(closed?.realizedPnlUsd);
    const feesNow = Number(closed?.feesPaidUsd);

    // Open baseline + risk in one read.
    let realizedAtOpen: number | null = null;
    let feesAtOpen: number | null = null;
    let riskAtOpen = NaN;
    try {
      const db = getServiceRoleClient();
      const { data: hrow } = await db
        .from('hypotheses')
        .select('risk_usd, realized_at_open_usd, fees_at_open_usd')
        .eq('id', hypothesisId)
        .maybeSingle();
      const h = hrow as { risk_usd: number | null; realized_at_open_usd: number | null; fees_at_open_usd: number | null } | null;
      riskAtOpen = Number(h?.risk_usd);
      if (Number.isFinite(Number(h?.realized_at_open_usd))) realizedAtOpen = Number(h?.realized_at_open_usd);
      if (Number.isFinite(Number(h?.fees_at_open_usd))) feesAtOpen = Number(h?.fees_at_open_usd);
    } catch { /* best-effort */ }

    const netPnl =
      Number.isFinite(realizedNow) && Number.isFinite(feesNow) && realizedAtOpen !== null && feesAtOpen !== null
        ? realizedNow - realizedAtOpen - (feesNow - feesAtOpen)
        : dir * (fill.px - position.avgEntryPx) * fill.sz - fill.feeUsd; // legacy / vanished-row fallback
    const status = netPnl > 0 ? 'confirmed' : netPnl < 0 ? 'invalidated' : 'resolved';
    const pnlLabel = `${netPnl >= 0 ? '+' : '-'}$${Math.abs(netPnl).toFixed(2)}`;
    // Realized R = net P&L / risk taken at open (null when the open predates the
    // structured fields — R stays uncomputable for legacy rows, never guessed).
    let realizedR: number | undefined;
    if (Number.isFinite(riskAtOpen) && riskAtOpen > 0) realizedR = netPnl / riskAtOpen;
    await resolveHypothesis({
      hypothesisId,
      status,
      resolutionNote: `${note ?? `scout closed ${coin}`} · realized ${pnlLabel}`,
      realizedPnlUsd: netPnl,
      realizedR,
    });
    line(`Resolved hypothesis ${hypothesisId} → ${status} (realized ${pnlLabel}).`);
  }
  // SESSION HYGIENE (egress fix, Aug 2026): each scout entry opens a dedicated
  // paper session that was never closed — 64 flat "active" sessions piled up, and
  // every daemon poll paid for all of them (a major term in the Supabase fair-use
  // overage). When this close leaves the session fully flat, close the session.
  // Best-effort: a failure just leaves one stale session for the next cleanup.
  if (closedAll) {
    try {
      const remaining = await loadOpenPositions(sessionId);
      if (remaining.length === 0) {
        await closeSession(sessionId);
        line(`Scout session ${sessionId.slice(0, 8)} is flat — closed.`);
      }
    } catch {
      /* best-effort hygiene */
    }
  }

  // Best-effort: the fill is committed and the hypothesis resolved; a logging blip must
  // not throw past here and skip the caller's 'scout-cycle' heartbeat (review D-MED).
  await writeAnalysisLog({
    sessionId,
    source: 'scout',
    message: `SCOUT closed ${fill.sz} ${coin} @ $${fill.px} (paper).${note ? ` ${note}` : ''}`,
  }).catch(() => {});
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
  const fromJson = typeof args['from-json'] === 'string';
  // A healthy headless cycle = a valid model decision that was actually HANDLED
  // (stand-down / propose / trade). Writing the 'scout-cycle' consumer heartbeat here
  // — after handling — rather than at snapshot-build time is what turns a
  // mis-replying or erroring consumer into a STALE row instead of a fresh 'ok'
  // (review D-HIGH). The parse-error path deliberately skips it so the row ages out
  // and the watchdog pages.
  const markCycleHealthy = (kind: string) =>
    writeScoutHeartbeat('ok', `headless decision handled (${kind})`, 'scout-cycle').catch(() => {});

  if (fromJson) {
    const parsed = parseScoutDecision(args['from-json'] as string);
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
      await markCycleHealthy('stand-down');
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
        await markCycleHealthy('propose-repeat');
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
      await markCycleHealthy('propose');
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
  // Headless trade handled end-to-end (fill + bookkeeping) → mark the consumer alive.
  if (fromJson) await markCycleHealthy(isExit ? 'close' : 'open');
});
