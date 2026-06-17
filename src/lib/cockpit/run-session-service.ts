/**
 * run-session ENTRY-CHAIN orchestration (I/O shell, dependency-injected).
 *
 * The deterministic half of the active-loop capstone: from a PICKED setup it
 * chains openSession → analyze-market → build entry proposal → requireApproval
 * (the NO-AUTO-FIRE popup) → on approval executeIntent → start the watch daemon →
 * arm the first Safe-Exit plan. The trading JUDGMENT + the wake cadence are NOT
 * here — those are the Claude session's job at runtime, guided by the
 * run-session SKILL.md playbook (a script cannot run scheduled wake-ups).
 *
 * HARD INVARIANTS preserved:
 *   - NO-AUTO-FIRE: executeIntent runs ONLY after `requireApproval` returns true.
 *     A reject/timeout returns WITHOUT executing AND without starting the monitor
 *     (no half-live session). Pinned by run-session-service.test.ts.
 *   - WATCH-ONLY: monitoring is started via `ensureWatchDaemon`, which can only
 *     spawn the watch daemon (statically pinned to never trade).
 *   - paper↔live seam untouched: execution goes through the injected
 *     `executeIntent` (the one mode-branching seam); this module never inspects
 *     mode beyond passing it to the approval gate for display.
 *
 * Every external effect is an injected dependency so the chain is unit-testable
 * with no real Supabase/HL/process. The thin script (scripts/run-session.ts)
 * wires the real implementations.
 */

import type { OrderSide, TradeIntent, TradingMode, CanonicalFill } from '@/types/fill';
import type { Position } from '@/types/position';
import type { Session, PendingActionDisplay } from '@/types/cockpit';
import type { L2Book } from '@/lib/hyperliquid/orderbook-match';
import type { HealthResult } from '@/lib/health/health-engine-types';
import type { OpenProposal } from '@/lib/skills/open-position-business-logic';
import type { MarketAssessment } from '@/lib/skills/analyze-market-business-logic';
import type { EnsureWatchResult } from './watch-spawn';
import type { BestExitPlan } from '@/lib/trading/safe-exit-plan-business-logic';

/** What the human PICKED — the only manual input besides the later APPROVE. */
export interface RunSessionPick {
  coin: string;
  /** Optional explicit side bias; when omitted the market read decides. */
  side?: OrderSide;
  /** Leader/trader being followed this session, if any. */
  leaderAddress?: string | null;
  /** Risk budget (USD) for the entry. */
  riskUsd: number;
  /** Stop distance as a fraction of entry (e.g. 0.04). */
  stopDistanceFrac: number;
  /** The thesis (becomes the tracked hypothesis). */
  thesis: string;
  /** Optional limit price for the entry; omit for market. */
  limitPx?: number;
}

/** Injected I/O + pure-builder dependencies (all the chain's external effects). */
export interface RunSessionDeps {
  mode: TradingMode;
  now: () => number;
  newId: () => string;
  openSession: (input: { mode: TradingMode; title: string; leaderAddress: string | null }) => Promise<Session>;
  /** The mark price to size + stop the entry against (latest candle close). */
  fetchMark: (coin: string) => Promise<number>;
  /** Multi-TF market read (reused analyze-market business logic, run by the script). */
  analyzeMarket: (coin: string, sessionId: string) => Promise<MarketAssessment>;
  buildEntryProposal: (args: {
    sessionId: string;
    coin: string;
    side: OrderSide;
    entryPx: number;
    riskUsd: number;
    stopDistanceFrac: number;
    limitPx?: number;
    clientIntentId: string;
    now: number;
    thesis: string;
  }) => OpenProposal;
  /** THE no-auto-fire gate. Resolves true ONLY on explicit approval. */
  requireApproval: (args: {
    sessionId: string;
    kind: 'entry';
    mode: TradingMode;
    proposal: { intent: TradeIntent; display: PendingActionDisplay };
  }) => Promise<boolean>;
  /** The ONE mode-branching seam. Runs ONLY after approval. */
  executeIntent: (intent: TradeIntent) => Promise<CanonicalFill>;
  writeHypothesis: (input: { sessionId: string; statement: string }) => Promise<{ id: string }>;
  /** Start the non-agent monitor (WATCH-ONLY). */
  ensureWatchDaemon: (intervalSeconds?: number) => EnsureWatchResult;
  /** Load the just-opened position to arm the first Safe-Exit plan against. */
  loadPosition: (sessionId: string, coin: string) => Promise<Position | null>;
  fetchL2Book: (coin: string) => Promise<L2Book>;
  assessHealth: (sessionId: string, coin: string, position: { side: Position['side']; entryPx: number; stopPx?: number }) => Promise<HealthResult>;
  buildBestExitPlan: (
    position: Position,
    book: L2Book,
    health: { score: number; pAdverse: number; alerts: string[] },
    input: { clientIntentId: string; sessionId: string; now: number },
  ) => BestExitPlan | null;
  upsertSafeExitPlan: (sessionId: string, intent: TradeIntent, reasoning: string | null, isFallback?: boolean) => Promise<unknown>;
  log: (msg: string) => void;
}

export interface RunSessionResult {
  sessionId: string;
  /** 'live' — entry filled + monitoring started; 'aborted' — not approved. */
  outcome: 'live' | 'aborted';
  /** The entry fill when it executed (null when aborted). */
  fill: CanonicalFill | null;
  /** Whether the watch daemon was spawned / already running (null when aborted). */
  watch: EnsureWatchResult | null;
  /** Whether the first Safe-Exit plan was armed (false when aborted). */
  safeExitArmed: boolean;
}

/**
 * Pick the entry side: explicit user bias wins; otherwise infer from the market
 * read (bullish → buy, bearish → sell). A neutral read with no explicit side is
 * refused (return null) — the user must pick a direction. PURE.
 */
export function resolveEntrySide(
  pick: Pick<RunSessionPick, 'side'>,
  assessment: Pick<MarketAssessment, 'biasLabel'>,
): OrderSide | null {
  if (pick.side === 'buy' || pick.side === 'sell') return pick.side;
  if (assessment.biasLabel === 'bullish') return 'buy';
  if (assessment.biasLabel === 'bearish') return 'sell';
  return null; // neutral + no explicit side ⇒ user must decide
}

/**
 * Run the deterministic entry chain. Returns 'aborted' WITHOUT executing or
 * starting the monitor when the approval gate is not satisfied (no-auto-fire).
 */
export async function runSessionEntryChain(
  pick: RunSessionPick,
  deps: RunSessionDeps,
): Promise<RunSessionResult> {
  const coin = pick.coin.trim().toUpperCase();
  const { log } = deps;

  // 1. Open the session.
  const session = await deps.openSession({
    mode: deps.mode,
    title: `${coin}${pick.side ? ` ${pick.side}` : ''}`,
    leaderAddress: pick.leaderAddress ?? null,
  });
  const sessionId = session.id;
  log(`Session ${sessionId} opened (mode=${deps.mode}).`);

  // 2. Analyze the market (reused business logic; logs an analysis_log row).
  const assessment = await deps.analyzeMarket(coin, sessionId);
  log(`Market read: ${assessment.summary}`);

  // 3. Resolve direction + the mark to size/stop against.
  const side = resolveEntrySide(pick, assessment);
  if (!side) {
    log('Neutral market read and no explicit --side — refusing to guess a direction. Aborted.');
    return { sessionId, outcome: 'aborted', fill: null, watch: null, safeExitArmed: false };
  }
  const entryPx = await deps.fetchMark(coin);

  // 4. Build the entry proposal (risk-based size + stop + rationale).
  const proposal = deps.buildEntryProposal({
    sessionId,
    coin,
    side,
    entryPx,
    riskUsd: pick.riskUsd,
    stopDistanceFrac: pick.stopDistanceFrac,
    limitPx: pick.limitPx,
    clientIntentId: deps.newId(),
    now: deps.now(),
    thesis: pick.thesis,
  });
  if (proposal.warnings.length > 0) {
    log(`Proposal has warnings — refusing to propose: ${proposal.warnings.join('; ')}`);
    return { sessionId, outcome: 'aborted', fill: null, watch: null, safeExitArmed: false };
  }
  log(proposal.rationale);

  // 5. THE no-auto-fire gate. Nothing below runs unless the human approves.
  const display: PendingActionDisplay = {
    coin,
    side,
    sz: proposal.intent.sz,
    estPx: Number.isFinite(entryPx) ? entryPx : null,
    stopPx: proposal.stopPx,
    rationale: proposal.rationale,
  };
  const approved = await deps.requireApproval({
    sessionId,
    kind: 'entry',
    mode: deps.mode,
    proposal: { intent: proposal.intent, display },
  });
  if (!approved) {
    log('Entry NOT approved (rejected/timeout) — nothing executed, no monitor started.');
    return { sessionId, outcome: 'aborted', fill: null, watch: null, safeExitArmed: false };
  }

  // 6. Execute the (approved) entry — the ONE mode-branching seam.
  const fill = await deps.executeIntent(proposal.intent);
  log(`Filled: ${fill.sz} ${fill.coin} @ $${fill.px} (source=${fill.source}, fee=$${fill.feeUsd.toFixed(4)}).`);
  await deps.writeHypothesis({ sessionId, statement: pick.thesis });

  // 7. Start the non-agent monitor (WATCH-ONLY) — comes up as the trade executes.
  const watch = deps.ensureWatchDaemon(20);
  log(
    watch.status === 'spawned'
      ? `Monitoring started — watch daemon spawned${watch.pid ? ` (pid ${watch.pid})` : ''}.`
      : 'Monitoring already running — existing watch daemon will pick this up next cycle.',
  );

  // 8. Arm the FIRST Safe-Exit plan against the freshly-opened position.
  const safeExitArmed = await armFirstSafeExit(sessionId, coin, proposal, deps);

  return { sessionId, outcome: 'live', fill, watch, safeExitArmed };
}

/**
 * Arm the initial smart Safe-Exit plan (mirrors refresh-exit, inline so the chain
 * is one unit). Fail-soft: a failure to arm logs a warning but does NOT undo the
 * already-live trade (the panic button still falls back to a market close).
 */
async function armFirstSafeExit(
  sessionId: string,
  coin: string,
  proposal: OpenProposal,
  deps: RunSessionDeps,
): Promise<boolean> {
  try {
    const position = await deps.loadPosition(sessionId, coin);
    if (!position || position.side === 'flat' || position.sz <= 0) {
      deps.log('WARN: no open position found to arm the Safe-Exit plan against.');
      return false;
    }
    const [book, health] = await Promise.all([
      deps.fetchL2Book(coin),
      deps.assessHealth(sessionId, coin, {
        side: position.side,
        entryPx: position.avgEntryPx,
        stopPx: proposal.stopPx,
      }),
    ]);
    const plan = deps.buildBestExitPlan(
      position,
      book,
      { score: health.score, pAdverse: health.pAdverse, alerts: health.alerts },
      { clientIntentId: deps.newId(), sessionId, now: deps.now() },
    );
    if (!plan) {
      deps.log('WARN: could not build a Safe-Exit plan (position flat).');
      return false;
    }
    await deps.upsertSafeExitPlan(sessionId, plan.intent, plan.reasoning, false);
    deps.log(`Safe-Exit armed (${plan.style}): ${plan.reasoning}`);
    return true;
  } catch (err) {
    deps.log(`WARN: failed to arm the first Safe-Exit plan (${err instanceof Error ? err.message : String(err)}). The panic button falls back to a market close.`);
    return false;
  }
}
