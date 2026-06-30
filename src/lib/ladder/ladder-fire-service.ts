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
  disarmLadder,
} from './ladder-service';
import { isLadderAutofireEnabled, isLadderLiveEnabled } from './ladder-flags';
import {
  rungWorstCaseLoss,
  addRiskCoveredByProfit,
  buildPreconditionSnapshot,
  hashPreconditionSnapshot,
  type LivePositionState,
} from './ladder-risk-business-logic';
import type { LadderRung, LadderWithRungs } from './ladder-types';
import { buildOpenProposal } from '@/lib/skills/open-position-business-logic';
import { buildMarketReduceOnlyClose } from '@/lib/trading/safe-exit-business-logic';
import { executeIntent } from '@/lib/trading/fill-source';
import { placeBracketOnHl, placeStopOnHl } from '@/lib/trading/stop-order-service';
import { loadPosition } from '@/lib/cockpit/fill-persistence-service';
import { getActiveSession, openSession } from '@/lib/cockpit/session-service';
import { fetchAllMids, fetchClearinghouseState, type HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getTradingMode } from '@/lib/env/mode';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { validateEnv } from '@/lib/env/env';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
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

/**
 * Live position state for the coins a rung depends on. FAIL-CLOSED: for a LIVE ladder
 * that depends on a position, an unreadable account (no address / stale feed) THROWS
 * rather than returning [] — otherwise "can't read live state" would hash identically to
 * "no positions" and silently bypass the §3.7 drift gate (a fire-open hole). A PAPER
 * ladder, or one with only `open` rungs (no live dependency), legitimately returns [].
 */
async function liveStateForLadder(ladder: LadderWithRungs): Promise<LivePositionState[]> {
  const dependsOnLive = ladder.rungs.some((r) => r.action === 'add' || r.action === 'reduce' || r.action === 'close');
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
  if (ladder.expiresAt && now >= Date.parse(ladder.expiresAt)) {
    await disarmLadder(ladder.id, 'expired');
    return skip('expired');
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

  // 6) ATOMIC claim — the double-fire guard. Only the inserter proceeds.
  const claim = await claimRungFire(ladder.id, rung.id);
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
  // If every rung is now terminal, the ladder's plan is fully executed → mark it DONE so the
  // UI shows completion and the watcher stops considering it. This rung just became 'fired'
  // (terminal); the others reflect their loaded status. markLadderDone is armed-guarded +
  // .catch'd — it runs AFTER the fill+bracket and can never harm the live position.
  const TERMINAL_RUNG = new Set(['fired', 'skipped', 'failed', 'cancelled']);
  if (ladder.rungs.every((r) => r.id === rung.id || TERMINAL_RUNG.has(r.status))) {
    await markLadderDone(ladder.id).catch(() => {});
  }
  await writeAnalysisLog({ sessionId, source: 'ladder-fire', severity: 'info', message: `FIRED ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: ${rung.action} ${side} ${filledSize} ${coin} @ ~${markPx} (${ladder.mode}${forcePaper ? ' · paper' : ''}).` }).catch(() => {});
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
  // 'reduce' trims a fraction (rung.sizeCoins / position) if specified; 'close' = full.
  const fraction = rung.action === 'close' || rung.sizeCoins == null || !(rung.sizeCoins > 0) ? 1 : Math.min(1, rung.sizeCoins / pos.sz);
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
  return { fired: true, skipped: null, fill };
}
