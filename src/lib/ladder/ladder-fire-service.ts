/**
 * performLadderRungFire — the ONE autonomous money-moving site for armed ladders.
 *
 * The watcher's PURE evaluator says "rung R's condition is met"; this re-validates
 * EVERYTHING server-side from the persisted row (never the request) and only then
 * executes the pre-authorized order through the same executeIntent seam every trade
 * rides. The kill-switch (LADDER_AUTOFIRE_ENABLED) is checked by the CALLER (the route)
 * before reaching here. Generalizes performRiskExit (exit-only → open/add/reduce/close).
 *
 * Guard stack, in order (each fail-closed; on doubt, SKIP — never fire):
 *   1. ladder exists, status='armed', not expired (else disarm-on-expiry)
 *   2. author='operator' (a scout ladder can NEVER fire — defense-in-depth w/ DB CHECK)
 *   3. rung exists + status='pending'
 *   4. precondition snapshot still matches (§3.7) — any live-state drift → auto-disarm
 *   5. ATOMIC claim via ladder_fires.dedupe_key — a double-fire gets claimed=false
 *   6. RUNTIME pyramiding guard (§2): an 'add' fires only if its worst-case loss is
 *      covered by the position's current unrealized profit
 *   7. execute → for open/add, ATOMICALLY bracket the fill; a bracket reject FLATTENS
 *      (the "filled-but-unstopped" hard fault)
 */

import { randomUUID } from 'node:crypto';
import {
  getLadderWithRungs,
  claimRungFire,
  markFireOutcome,
  setRungStatus,
  markLadderDone,
  disarmOcoSiblings,
  disarmLadder,
} from './ladder-service';
import { isLadderAutofireEnabled, isLadderLiveEnabled } from './ladder-flags';
import {
  rungWorstCaseLoss,
  addRiskCoveredByProfit,
  buildPreconditionSnapshot,
  hashPreconditionSnapshot,
  reduceFraction,
  type LivePositionState,
} from './ladder-risk-business-logic';
import type { LadderRung, LadderWithRungs } from './ladder-types';
import { buildOpenProposal } from '@/lib/skills/open-position-business-logic';
import { buildMarketReduceOnlyClose } from '@/lib/trading/safe-exit-business-logic';
import { executeIntent } from '@/lib/trading/fill-source';
import { placeBracketOnHl, placeStopOnHl, findOpenStop, cancelStopOnHl } from '@/lib/trading/stop-order-service';
import { setAdvisoryStop } from '@/lib/scout/scout-watch-service';
import { loadPosition } from '@/lib/cockpit/fill-persistence-service';
import { getActiveSession, openSession } from '@/lib/cockpit/session-service';
import { fetchAllMids, fetchClearinghouseState, type HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getTradingMode } from '@/lib/env/mode';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { validateEnv } from '@/lib/env/env';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';
import { ladderWindowState, ACTS_ON_LIVE_POSITION, WATCH_CANDLE_MS } from './ladder-types';
import { bookHeatUsd } from './ladder-risk-business-logic';
import { checkCircuitBreaker } from '@/lib/risk/circuit-breaker-service';
import { findAllStops } from '@/lib/trading/stop-order-service';
import type { CanonicalFill, OrderSide } from '@/types/fill';
import type { Position } from '@/types/position';

export interface LadderFireResult {
  fired: boolean;
  /** Why nothing fired (a SKIP reason), or null when it fired. */
  skipped: string | null;
  fill?: CanonicalFill;
  /** True when a bracket reject forced a flatten (hard fault — surfaced loudly). */
  flattened?: boolean;
}

const orderSideOf = (side: 'long' | 'short'): OrderSide => (side === 'long' ? 'buy' : 'sell');
const skip = (reason: string): LadderFireResult => ({ fired: false, skipped: reason });

/** Fire-time book-heat ceiling as a fraction of live equity (EDGE_ROADMAP gap 3a).
 *  NaN-PROOF: a typo'd env value must fail CLOSED to the default, never disable the
 *  gate (bare Number('x') = NaN and `heat > NaN` is always false — the fail-open trap). */
const BOOK_HEAT_MAX_FRAC = (() => {
  const f = Number(process.env.LADDER_BOOK_HEAT_MAX_FRAC);
  return Number.isFinite(f) && f > 0 && f <= 1 ? f : 0.10;
})();

/**
 * Live position state for the coins a rung depends on. FAIL-CLOSED: for a LIVE ladder
 * that depends on a position, an unreadable account (no address / stale feed) THROWS
 * rather than returning [] — otherwise "can't read live state" would hash identically to
 * "no positions" and silently bypass the §3.7 drift gate (a fire-open hole). A PAPER
 * ladder, or one with only `open` rungs (no live dependency), legitimately returns [].
 */
async function liveStateForLadder(ladder: LadderWithRungs): Promise<LivePositionState[]> {
  const dependsOnLive = ladder.rungs.some((r) => ACTS_ON_LIVE_POSITION(r.action));
  if (ladder.mode !== 'live' || !dependsOnLive) return [];
  const address = getHlAccountAddress();
  if (!address) throw new Error('cannot verify precondition: no HL account address for a live position-dependent ladder');
  const ch = await fetchClearinghouseState(address, { uncached: true });
  if (ch.stale) throw new Error('cannot verify precondition: live clearinghouse feed is stale');
  return ch.positions.map((p) => ({ coin: p.coin, side: p.side, leverage: p.leverage }));
}

/** Unrealized profit (USD) for the add-guard: the live HL truth when available, else a
 *  paper estimate from the ledger position + current mark. */
function unrealizedProfitUsd(posSide: string, avgEntryPx: number, sz: number, markPx: number, hlPos: HlPosition | null): number {
  if (hlPos) return hlPos.unrealizedPnl;
  if (posSide === 'flat' || !(markPx > 0) || !(avgEntryPx > 0) || !(sz > 0)) return 0;
  const dir = posSide === 'long' ? 1 : -1;
  return (markPx - avgEntryPx) * dir * sz;
}

async function alert(sessionId: string, message: string): Promise<void> {
  try { await writeAnalysisLog({ sessionId, source: 'ladder-fire', severity: 'danger', message }); } catch { /* never mask the outcome */ }
  // Operator page: danger-class fire events (fault-flattens, unstopped positions) go to
  // Discord too. Best-effort — a webhook failure must never mask or break the outcome.
  await sendDiscord(`🚨 ${message}`, 'HL Ladder Watch').catch(() => {});
}

export async function performLadderRungFire(args: { ladderId: string; rungId: string; now: number }): Promise<LadderFireResult> {
  const { ladderId, rungId, now } = args;

  // 0) Belt-and-suspenders kill-switch at the SEAM (the route checks it first, but the
  // ONE money-moving site must refuse autonomous fire if autofire is off, for any caller).
  if (!isLadderAutofireEnabled()) return skip('autofire-disabled');

  // 1) Ladder must exist, be ARMED, and unexpired.
  const ladder = await getLadderWithRungs(ladderId);
  if (!ladder) return skip('ladder-not-found');
  if (ladder.status !== 'armed') return skip(`not-armed(${ladder.status})`);
  const window = ladderWindowState(ladder, now);
  if (window === 'expired') {
    await disarmLadder(ladder.id, 'expired');
    return skip('expired');
  }
  // 1b) Activation window (same predicate as the watcher — ladderWindowState): an armed
  // ladder is NOT yet fireable before active_from. Restrictive only — refuse, stay armed.
  if (window === 'before-window') {
    return skip('before-active-from');
  }
  // 2) Defense-in-depth with the §3.6 DB CHECK: a scout ladder can NEVER fire.
  if (ladder.author !== 'operator') return skip('not-operator');

  // 2b) MODE-MATCH: a deployment fires ONLY ladders of its OWN mode. In the shared-DB
  // topology (paper box + live box on one Supabase) this stops a PAPER deployment's
  // watcher from claiming + simulating a LIVE ladder's rung (which would spend the
  // one-shot claim so the LIVE box could never fire it — a silent loss of the operator's
  // live authorization). Skip BEFORE the claim so the matching deployment still fires it.
  const deploymentLive = getTradingMode() === 'live';
  if ((ladder.mode === 'live') !== deploymentLive) return skip('mode-mismatch');
  // 2c) LADDER_LIVE_ENABLED is a live kill-switch at FIRE too (not only at arm): flipping
  // it off must immediately stop an already-armed live ladder from firing.
  if (ladder.mode === 'live' && !isLadderLiveEnabled()) return skip('live-disabled');

  // 3) Rung must exist + still be pending.
  const rung = ladder.rungs.find((r) => r.id === rungId);
  if (!rung) return skip('rung-not-found');
  if (rung.status !== 'pending') return skip(`rung-${rung.status}`);

  // 4) Precondition re-check (§3.7): re-derive the snapshot from CURRENT live state and
  // compare. Any drift (side flip, position vanished, leverage change) → auto-disarm.
  // An UNREADABLE live state (live + position-dependent) throws → fail-closed skip, never
  // a silent "no drift". (PAPER / open-only ladders carry an empty, always-matching snapshot.)
  let live: LivePositionState[];
  try {
    live = await liveStateForLadder(ladder);
  } catch {
    return skip('cannot-verify-precondition');
  }
  const freshHash = hashPreconditionSnapshot(buildPreconditionSnapshot(ladder.rungs, live));
  if (ladder.preconditionHash && freshHash !== ladder.preconditionHash) {
    // Auto-disarm; disarm_reason records it (no session yet for an analysis-log line).
    await disarmLadder(ladder.id, 'precondition-drift');
    return skip('precondition-drift');
  }

  // 5) Fresh mark (uncached) — fetched BEFORE the claim so a transient bad mark skips
  // WITHOUT burning the one-shot claim (the rung stays pending, retryable next tick).
  const coin = rung.coin.toUpperCase();
  const mids = await fetchAllMids(validateEnv().HL_NETWORK, { uncached: true });
  const markPx = mids[coin];
  if (!Number.isFinite(markPx) || markPx <= 0) return skip('bad-mark');

  // 5b) EXPOSURE GATES (live opens/adds only; risk-reducing rungs are NEVER blocked).
  // Both fail CLOSED on unreadable state and sit BEFORE the claim (skip = retryable).
  if ((rung.action === 'open' || rung.action === 'add') && ladder.mode === 'live' && getTradingMode() === 'live') {
    // (i) LIVE circuit breaker — a daily-loss/drawdown trip freezes autonomous
    // entries (EDGE_ROADMAP gap 3c). Exits/ratchets always pass.
    let equity: number;
    try {
      const breaker = await checkCircuitBreaker('live', now);
      if (breaker.blockNewEntries) return skip(`circuit-breaker: ${breaker.reason}`);
      equity = breaker.equityUsd; // reuse — a second computeLiveEquity would double the reads
    } catch (e) {
      return skip(`cannot-verify-breaker: ${e instanceof Error ? e.message : String(e)}`);
    }
    // (ii) BOOK HEAT ceiling (gap 3a): slip-aware worst case of everything open +
    // THIS rung must stay under the ceiling fraction of live equity.
    try {
      const address = getHlAccountAddress();
      if (!address) return skip('cannot-verify-heat: no account address');
      const ch = await fetchClearinghouseState(address, { uncached: true });
      if (ch.stale || ch.error) return skip('cannot-verify-heat: clearinghouse unreadable');
      const stops = await findAllStops();
      const heatPositions = ch.positions.map((p) => ({
        sz: p.size,
        markPx: mids[p.coin.toUpperCase()] ?? p.entryPx ?? 0,
        stopPx: stops[p.coin.toUpperCase()]?.triggerPx ?? null,
      }));
      const gateSizeCoins =
        rung.riskUsd != null && rung.stopFrac != null && rung.stopFrac > 0
          ? rung.riskUsd / (markPx * rung.stopFrac)
          : rung.sizeCoins; // absolute-coin rungs must still weigh in (review L6)
      const gateStopPx = rung.stopFrac != null ? (rung.side === 'long' ? markPx * (1 - rung.stopFrac) : markPx * (1 + rung.stopFrac)) : rung.stopPx;
      const rungWorst = rungWorstCaseLoss({ side: rung.side, action: rung.action, entryPx: markPx, sizeCoins: gateSizeCoins ?? null, stopPx: gateStopPx ?? null });
      const heat = bookHeatUsd(heatPositions) + rungWorst;
      const ceiling = BOOK_HEAT_MAX_FRAC * equity;
      if (heat > ceiling) {
        await writeAnalysisLog({ sessionId: (await getActiveSession())?.id ?? '', source: 'ladder-fire', severity: 'warn', message: `HEAT GATE: skipped ${coin} ${rung.action} — book heat $${heat.toFixed(0)} > ceiling $${ceiling.toFixed(0)} (${(BOOK_HEAT_MAX_FRAC * 100).toFixed(0)}% of $${equity.toFixed(0)})` }).catch(() => {});
        return skip(`book-heat-exceeded ($${heat.toFixed(0)} > $${ceiling.toFixed(0)})`);
      }
    } catch (e) {
      return skip(`cannot-verify-heat: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 6) ATOMIC claim — the double-fire guard. Only the inserter proceeds. TRAIL
  // stop_move rungs claim PER COMPLETED CANDLE (they re-fire as price advances);
  // everything else stays strictly one-shot.
  const isTrail = rung.action === 'stop_move' && rung.triggerMeta?.moveTo === 'trail';
  const claim = await claimRungFire(ladder.id, rung.id, isTrail ? String(Math.floor(now / WATCH_CANDLE_MS)) : undefined);
  if (!claim.claimed || !claim.fireId) return skip('already-fired');
  const fireId = claim.fireId;

  try {
    const session = (await getActiveSession()) ?? (await openSession({ mode: ladder.mode, title: `ladder ${ladder.id.slice(0, 8)}`, leaderAddress: null }));
    // A fill is LIVE only when the ladder is live AND the deployment is live — a PAPER
    // ladder ALWAYS simulates (forcePaper), even on a live deployment. This is the
    // ladder-mode-respecting fill the global TRADING_MODE switch alone would not give.
    const forcePaper = !(ladder.mode === 'live' && getTradingMode() === 'live');

    if (rung.action === 'reduce' || rung.action === 'close') {
      return await fireReduce(ladder, rung, session.id, coin, fireId, forcePaper);
    }
    if (rung.action === 'stop_move') {
      return await fireStopMove(ladder, rung, session.id, coin, fireId, forcePaper, markPx);
    }
    // Defense-in-depth (arm validation is the first gate): a SIGNAL-driven trigger must
    // be structurally incapable of opening/adding — refuse here too, so a direct DB
    // insert or a future arm-validation regression can never invert exit-only into entry.
    if (rung.triggerKind === 'indicator') {
      await markFireOutcome(fireId, 'failed', 'indicator-cannot-open');
      await setRungStatus(rung.id, 'failed');
      return skip('indicator triggers are exit-only — refusing open/add');
    }
    return await fireOpenOrAdd(ladder, rung, session.id, coin, markPx, fireId, forcePaper);
  } catch (e) {
    await markFireOutcome(fireId, 'failed', e instanceof Error ? e.message : String(e));
    await setRungStatus(rung.id, 'failed');
    throw e;
  }
}

/** OPEN / ADD — increases exposure. ADD is gated by the runtime risk-covered-by-profit
 *  rule; both atomically bracket the fill (stop[+target]); a bracket reject FLATTENS. */
async function fireOpenOrAdd(ladder: LadderWithRungs, rung: LadderRung, sessionId: string, coin: string, markPx: number, fireId: string, forcePaper: boolean): Promise<LadderFireResult> {
  const side = rung.side;
  // Size + stop come from the rung's risk inputs, computed at the CURRENT mark.
  const stopFrac = rung.stopFrac ?? (rung.stopPx != null && rung.stopPx > 0 ? Math.abs(markPx - rung.stopPx) / markPx : null);
  const riskUsd = rung.riskUsd;
  if (riskUsd == null || riskUsd <= 0 || stopFrac == null || !(stopFrac > 0)) {
    await markFireOutcome(fireId, 'failed', 'rung-missing-risk-or-stop');
    await setRungStatus(rung.id, 'failed'); // terminal — the claim is spent
    return skip('rung-missing-risk-or-stop');
  }

  // Build the OPEN intent FIRST (risk-sized at the mark; reduceOnly:false) so every guard
  // measures the ACTUAL order (size = riskUsd/(mark·stopFrac), stop = proposal.stopPx) —
  // not a trigger-derived size that could understate the add's real worst-case loss.
  const proposal = buildOpenProposal({
    sessionId, coin, side: orderSideOf(side), entryPx: markPx, riskUsd, stopDistanceFrac: stopFrac,
    leverage: rung.leverage ?? 1, clientIntentId: randomUUID(), now: Date.now(),
    thesis: `Ladder ${ladder.id.slice(0, 8)} rung ${rung.seq} ${rung.action} ${coin}`,
  });
  if (proposal.warnings.length > 0) {
    await markFireOutcome(fireId, 'failed', `unsafe: ${proposal.warnings.join(' ')}`);
    await setRungStatus(rung.id, 'failed');
    return skip('unsafe-setup');
  }

  // RUNTIME pyramiding guard (§2) for an ADD: the worst-case loss of THIS ORDER must be
  // covered by the existing position's CURRENT unrealized profit, else it's a martingale
  // add — refuse (BEFORE executeIntent, so a refused add never touches the exchange).
  if (rung.action === 'add') {
    const pos = await loadPosition(sessionId, coin);
    let hlPos: HlPosition | null = null;
    if (getTradingMode() === 'live') {
      const address = getHlAccountAddress();
      if (address) hlPos = (await fetchClearinghouseState(address, { uncached: true })).positions.find((p) => p.coin.toUpperCase() === coin) ?? null;
    }
    const profit = pos ? unrealizedProfitUsd(pos.side, pos.avgEntryPx, pos.sz, markPx, hlPos) : (hlPos?.unrealizedPnl ?? 0);
    const addRisk = rungWorstCaseLoss({ side, action: 'add', entryPx: markPx, sizeCoins: proposal.intent.sz, stopPx: proposal.stopPx });
    if (!addRiskCoveredByProfit(addRisk, profit)) {
      await markFireOutcome(fireId, 'failed', `add-risk-not-covered (risk $${addRisk.toFixed(0)} > profit $${profit.toFixed(0)})`);
      await setRungStatus(rung.id, 'skipped');
      return skip('add-risk-not-covered');
    }
  }

  // (1) EXECUTE the open. executeIntent does liveFill → persistFill → applyFillToPosition,
  // so a Supabase write throwing AFTER a live fill leaves a real open position → FLATTEN
  // (never leave it unstopped). filledSize defaults to the intended size for that flatten.
  let filledSize = proposal.intent.sz;
  let fill;
  try {
    fill = await executeIntent(proposal.intent, { forcePaper });
  } catch (err) {
    return await flattenAfterFault(ladder, rung, sessionId, coin, fireId, forcePaper, filledSize, `open-threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // (2) Zero-fill (IOC didn't cross): no exposure opened — nothing to bracket or fire.
  if (!(fill.sz > 0)) {
    await markFireOutcome(fireId, 'failed', 'no-fill');
    await setRungStatus(rung.id, 'failed');
    return skip('no-fill');
  }
  filledSize = fill.sz;

  // (3) Bracket the fill ATOMICALLY (invariant §3.3) — but ONLY a live fill. A PAPER
  // ladder places NO real exchange orders (placeBracket/placeStop gate on the GLOBAL
  // TRADING_MODE, so without this guard a paper ladder on a live deployment would rest a
  // REAL stop/TP). A bracket reject → FLATTEN (filled-but-unstopped fault).
  if (!forcePaper) {
    try {
      if (rung.targetPx != null && rung.targetPx > 0) await placeBracketOnHl(coin, proposal.stopPx, rung.targetPx, filledSize, side);
      else await placeStopOnHl(coin, proposal.stopPx, filledSize, side);
    } catch (err) {
      return await flattenAfterFault(ladder, rung, sessionId, coin, fireId, forcePaper, filledSize, `bracket-reject: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // (4) SUCCESS telemetry — OUTSIDE any flatten-guarded try. The fill is in and (if live)
  // stopped; a transient telemetry/Supabase failure here must NOT flatten a good position.
  await markFireOutcome(fireId, 'filled').catch(() => {});
  await setRungStatus(rung.id, 'fired').catch(() => {});
  // OCO one-cancels-other: this leg committed → auto-disarm its straddle sibling(s) so a
  // whipsaw can't also fire the opposite side (which would net against this fill on HL).
  // Disarm-only (removes authorization, never moves money) + .catch'd — can't harm the fill.
  if (ladder.ocoGroupId) {
    await disarmOcoSiblings(ladder.ocoGroupId, ladder.id, `oco: ${ladder.id.slice(0, 8)} fired rung ${rung.seq}`).catch(() => {});
  }
  // If every rung is now terminal, the ladder's plan is fully executed → mark it DONE so the
  // UI shows completion and the watcher stops considering it. This rung just became 'fired'
  // (terminal); the others reflect their loaded status. markLadderDone is armed-guarded +
  // .catch'd — it runs AFTER the fill+bracket and can never harm the live position.
  const TERMINAL_RUNG = new Set(['fired', 'skipped', 'failed', 'cancelled']);
  if (ladder.rungs.every((r) => r.id === rung.id || TERMINAL_RUNG.has(r.status))) {
    await markLadderDone(ladder.id).catch(() => {});
  }
  await writeAnalysisLog({ sessionId, source: 'ladder-fire', severity: 'info', message: `FIRED ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: ${rung.action} ${side} ${filledSize} ${coin} @ ~${markPx} (${ladder.mode}${forcePaper ? ' · paper' : ''}).` }).catch(() => {});
  // Operator push: every committed fire pages Discord (the operator asked for ALL hits).
  await sendDiscord(
    `🔥 **LADDER FIRE** ${ladder.title.slice(0, 60)} — rung ${rung.seq} ${rung.action.toUpperCase()} ${side} ${filledSize} ${coin} @ ~$${fill.px} (${ladder.mode}${forcePaper ? ' · paper' : ''}). Stop ~$${proposal.stopPx}.`,
    'HL Ladder Watch',
  ).catch(() => {});
  return { fired: true, skipped: null, fill };
}

/**
 * The just-fired open/add faulted AFTER a possible fill (post-fill DB error or a bracket
 * reject). Flatten the exposure reduce-only and record the outcome. Reads the EFFECTIVE
 * position (live HL when not paper) so it closes what's really open. If the flatten ALSO
 * fails, record a distinct CRITICAL "UNSTOPPED" fault + page — never mislabel it 'flattened'.
 */
async function flattenAfterFault(ladder: LadderWithRungs, rung: LadderRung, sessionId: string, coin: string, fireId: string, forcePaper: boolean, reduceSize: number, detail: string): Promise<LadderFireResult> {
  let flattenOk = false;
  try {
    const pos = await loadEffectivePosition(sessionId, coin, forcePaper);
    if (pos && pos.side !== 'flat' && pos.sz > 0) {
      const fraction = reduceSize > 0 ? Math.min(1, reduceSize / pos.sz) : 1; // close just this rung's add; base keeps its own stop
      const closeIntent = buildMarketReduceOnlyClose(pos, { sessionId, clientIntentId: randomUUID(), now: Date.now(), fraction });
      if (closeIntent) { await executeIntent(closeIntent, { forcePaper }); flattenOk = true; }
      else flattenOk = true;
    } else {
      flattenOk = true; // nothing open to flatten (rejected pre-fill / already flat)
    }
  } catch { flattenOk = false; }
  await setRungStatus(rung.id, 'failed');
  if (flattenOk) {
    await markFireOutcome(fireId, 'flattened', `fault-flattened: ${detail}`);
    await alert(sessionId, `Ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: fault after fill — FLATTENED (filled-but-unstopped fault). ${detail}`);
    return { fired: false, skipped: 'fault-flattened', flattened: true };
  }
  await markFireOutcome(fireId, 'failed', `CRITICAL fault AND flatten-FAILED — possible UNSTOPPED position: ${detail}`);
  await alert(sessionId, `🚨 Ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: fault AND flatten FAILED — ${coin} may be UNSTOPPED. Manual intervention required. ${detail}`);
  return { fired: false, skipped: 'fault-flatten-failed', flattened: false };
}

/** The position to size a close against: the LIVE HL position when not paper, else the
 *  paper ledger. Returns null only when the read SUCCEEDS and the coin is genuinely flat.
 *  THROWS when a LIVE position can't be read (no address / feed error) — callers MUST
 *  fail-closed: the ledger could miss a just-placed-but-unpersisted live fill, so treating
 *  an unreadable live account as "flat" would let a flatten mark 'flattened' over a real
 *  naked position (the CRIT-B hole). */
async function loadEffectivePosition(sessionId: string, coin: string, forcePaper: boolean): Promise<Position | null> {
  if (forcePaper) return loadPosition(sessionId, coin);
  const address = getHlAccountAddress();
  if (!address) throw new Error('cannot read live position: no HL account address');
  const ch = await fetchClearinghouseState(address, { uncached: true }); // throws on feed error → caller fails closed
  const hl = ch.positions.find((p) => p.coin.toUpperCase() === coin.toUpperCase());
  if (!hl || !(hl.size > 0)) return null; // read succeeded, genuinely flat
  return { coin: coin.toUpperCase(), side: hl.side, sz: hl.size, avgEntryPx: hl.entryPx ?? 0, realizedPnlUsd: 0, feesPaidUsd: 0 };
}

/**
 * STOP_MOVE — ratchet the position's RESTING stop to triggerMeta.moveTo. RISK-REDUCING
 * ONLY, enforced live at fire: the new stop must be tighter than the current one and on
 * the protective side of the fresh mark. Ordering is place-NEW-then-cancel-OLD so the
 * position is never unstopped mid-move (both stops are reduce-only; a brief overlap is
 * harmless, an unstopped gap is not). Paper ladders simulate by updating the advisory
 * stop column. Never places an entry/exit order.
 */
async function fireStopMove(ladder: LadderWithRungs, rung: LadderRung, sessionId: string, coin: string, fireId: string, forcePaper: boolean, markPx: number): Promise<LadderFireResult> {
  let pos: Position | null;
  try {
    pos = await loadEffectivePosition(sessionId, coin, forcePaper);
  } catch (e) {
    await markFireOutcome(fireId, 'failed', `cannot-read-position: ${e instanceof Error ? e.message : String(e)}`);
    await setRungStatus(rung.id, 'skipped');
    return skip('cannot-read-position');
  }
  if (!pos || pos.side === 'flat' || pos.sz <= 0) {
    await markFireOutcome(fireId, 'failed', 'flat');
    await setRungStatus(rung.id, 'skipped');
    return skip('flat');
  }
  const mv = rung.triggerMeta?.moveTo;
  const isTrail = mv === 'trail';
  const trailD = rung.triggerMeta?.trailDistancePx;
  const newStop = isTrail
    ? (typeof trailD === 'number' && trailD > 0 ? (pos.side === 'long' ? markPx - trailD : markPx + trailD) : NaN)
    : mv === 'breakeven' ? pos.avgEntryPx : typeof mv === 'number' ? mv : NaN;
  if (!(Number.isFinite(newStop) && newStop > 0)) {
    // An invalid destination is a PERMANENT config error — terminate the rung even for
    // trails (only the benign not-tighter-yet case may keep a trail pending; review L5).
    await markFireOutcome(fireId, 'failed', 'invalid-moveTo');
    await setRungStatus(rung.id, 'failed');
    return skip('invalid-moveTo');
  }
  // Protective-side check vs the FRESH mark: a stop at/through the mark would fire
  // instantly (a disguised market close — that's a reduce rung's job, not ours).
  const rightSideOfMark = pos.side === 'long' ? newStop < markPx : newStop > markPx;
  if (!rightSideOfMark) {
    await markFireOutcome(fireId, 'failed', `stop ${newStop} not protective vs mark ${markPx}`);
    await setRungStatus(rung.id, 'skipped');
    return skip('stop-would-trigger');
  }

  if (forcePaper) {
    // Paper: no exchange orders — simulate the ratchet on the advisory stop column.
    // (No tighter-than-old check here: the advisory column has no authoritative "old"
    // to compare against exchange-side; paper exists to exercise the flow, not P&L.)
    await setAdvisoryStop(sessionId, coin, newStop).catch(() => false);
    await markFireOutcome(fireId, 'filled', `paper stop→${newStop}${isTrail ? ' (trail)' : ''}`);
    if (!isTrail) {
      await setRungStatus(rung.id, 'fired').catch(() => {});
      const PAPER_TERMINAL = new Set(['fired', 'skipped', 'failed', 'cancelled']);
      if (ladder.rungs.every((r) => r.id === rung.id || PAPER_TERMINAL.has(r.status))) {
        await markLadderDone(ladder.id).catch(() => {});
      }
    } // trail rungs stay PENDING on paper too — they re-fire per candle
    await writeAnalysisLog({ sessionId, source: 'ladder-fire', severity: 'info', message: `STOP-MOVE (paper) ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: ${coin} advisory stop → ${newStop}.` }).catch(() => {});
    return { fired: true, skipped: null };
  }

  // RISK-REDUCING vs the current resting stop (if any): long may only RAISE, short only LOWER.
  let oldStop: Awaited<ReturnType<typeof findOpenStop>> = null;
  try {
    oldStop = await findOpenStop(coin);
  } catch (e) {
    await markFireOutcome(fireId, 'failed', `cannot-read-resting-stop: ${e instanceof Error ? e.message : String(e)}`);
    await setRungStatus(rung.id, 'skipped');
    return skip('cannot-read-resting-stop');
  }
  const oldPx = oldStop?.triggerPx != null ? Number(oldStop.triggerPx) : null;
  if (oldPx != null && Number.isFinite(oldPx)) {
    const tighter = pos.side === 'long' ? newStop > oldPx + 1e-9 : newStop < oldPx - 1e-9;
    if (!tighter) {
      await markFireOutcome(fireId, 'failed', isTrail ? `trail-noop (stop ${oldPx} already tighter than ${newStop} — benign, waiting)` : `not-risk-reducing (old ${oldPx} → new ${newStop}, ${pos.side})`);
      // A TRAIL that isn't tighter this candle simply waits for the next one (the rung
      // stays pending); a fixed-destination move that isn't tighter is done for good.
      if (!isTrail) await setRungStatus(rung.id, 'skipped');
      return skip('not-risk-reducing');
    }
  }

  // Place the NEW stop first (full current size), THEN cancel the old — never unstopped.
  try {
    const placed = await placeStopOnHl(coin, newStop, pos.sz, pos.side);
    if (!placed.pushed) throw new Error('placeStopOnHl not pushed');
  } catch (e) {
    await markFireOutcome(fireId, 'failed', `stop-place-failed: ${e instanceof Error ? e.message : String(e)}`);
    await setRungStatus(rung.id, 'failed');
    await alert(sessionId, `Ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: stop_move FAILED to place the new ${coin} stop @ ${newStop} — the OLD stop still rests (position protected; ratchet lost).`);
    return skip('stop-place-failed');
  }
  if (oldStop?.oid != null) {
    try {
      await cancelStopOnHl(coin, oldStop.oid);
    } catch {
      // Both stops rest (both reduce-only — the tighter one governs economically).
      // Not a fault; page the operator to clean up the stale order.
      await alert(sessionId, `Ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: new ${coin} stop @ ${newStop} placed but the OLD stop (oid ${oldStop.oid}) failed to cancel — cancel it manually; the tighter stop governs.`);
    }
  }
  await markFireOutcome(fireId, 'filled', `stop→${newStop}${oldPx != null ? ` (from ${oldPx})` : ' (no prior stop)'}${isTrail ? ' (trail)' : ''}`).catch(() => {});
  if (!isTrail) {
    await setRungStatus(rung.id, 'fired').catch(() => {});
    const TERMINAL_RUNG = new Set(['fired', 'skipped', 'failed', 'cancelled']);
    if (ladder.rungs.every((r) => r.id === rung.id || TERMINAL_RUNG.has(r.status))) {
      await markLadderDone(ladder.id).catch(() => {});
    }
  } // trail rungs stay PENDING — they re-fire per candle until expiry or a flat position
  await writeAnalysisLog({ sessionId, source: 'ladder-fire', severity: 'info', message: `STOP-MOVE ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: ${coin} ${pos.side} resting stop → ${newStop}${oldPx != null ? ` (from ${oldPx})` : ''}.` }).catch(() => {});
  await sendDiscord(
    `🔒 **STOP RATCHET** ${ladder.title.slice(0, 60)} — ${coin} ${pos.side} stop moved to $${newStop}${oldPx != null ? ` (from $${oldPx})` : ''}${mv === 'breakeven' ? ' (breakeven)' : ''}. Worst case now locked.`,
    'HL Ladder Watch',
  ).catch(() => {});
  return { fired: true, skipped: null };
}

/** REDUCE / CLOSE — reduce-only, sized from the EFFECTIVE (live-when-live) position so a
 *  ledger that lags the venue can't under-close. Can never open/flip (reduceOnly). */
async function fireReduce(ladder: LadderWithRungs, rung: LadderRung, sessionId: string, coin: string, fireId: string, forcePaper: boolean): Promise<LadderFireResult> {
  let pos: Position | null;
  try {
    pos = await loadEffectivePosition(sessionId, coin, forcePaper);
  } catch (e) {
    // Can't read the live position → don't blindly reduce. Skip (the position keeps its
    // existing protection); the claim is spent (one-shot), operator can re-arm.
    await markFireOutcome(fireId, 'failed', `cannot-read-position: ${e instanceof Error ? e.message : String(e)}`);
    await setRungStatus(rung.id, 'skipped');
    return skip('cannot-read-position');
  }
  if (!pos || pos.side === 'flat' || pos.sz <= 0) {
    await markFireOutcome(fireId, 'failed', 'flat');
    await setRungStatus(rung.id, 'skipped');
    return skip('flat');
  }
  // 'reduce' trims a fraction of the CURRENT position — reduceFrac (path-independent) is
  // preferred, else the absolute sizeCoins/position, else full; 'close' = full.
  const fraction = reduceFraction({ action: rung.action, reduceFrac: rung.reduceFrac, sizeCoins: rung.sizeCoins, positionSz: pos.sz });
  const intent = buildMarketReduceOnlyClose(pos, { sessionId, clientIntentId: randomUUID(), now: Date.now(), fraction });
  if (!intent) {
    await markFireOutcome(fireId, 'failed', 'no-close-intent');
    await setRungStatus(rung.id, 'failed');
    return skip('no-close-intent');
  }
  const fill = await executeIntent(intent, { forcePaper });
  await markFireOutcome(fireId, 'filled');
  await setRungStatus(rung.id, 'fired');
  await writeAnalysisLog({ sessionId, source: 'ladder-fire', severity: 'info', message: `FIRED ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: ${rung.action} ${coin} (frac ${fraction.toFixed(2)}, ${ladder.mode}${forcePaper ? ' · paper' : ''}).` }).catch(() => {});
  await sendDiscord(
    `💰 **LADDER BANK** ${ladder.title.slice(0, 60)} — rung ${rung.seq} ${rung.action.toUpperCase()} ${(fraction * 100).toFixed(0)}% of ${coin} (${ladder.mode}${forcePaper ? ' · paper' : ''}).`,
    'HL Ladder Watch',
  ).catch(() => {});
  return { fired: true, skipped: null, fill };
}
