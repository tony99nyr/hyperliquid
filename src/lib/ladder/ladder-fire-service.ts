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
  disarmLadder,
} from './ladder-service';
import { isLadderAutofireEnabled } from './ladder-flags';
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

    if (rung.action === 'reduce' || rung.action === 'close') {
      return await fireReduce(ladder, rung, session.id, coin, fireId);
    }
    return await fireOpenOrAdd(ladder, rung, session.id, coin, markPx, fireId);
  } catch (e) {
    await markFireOutcome(fireId, 'failed', e instanceof Error ? e.message : String(e));
    await setRungStatus(rung.id, 'failed');
    throw e;
  }
}

/** OPEN / ADD — increases exposure. ADD is gated by the runtime risk-covered-by-profit
 *  rule; both atomically bracket the fill (stop[+target]); a bracket reject FLATTENS. */
async function fireOpenOrAdd(ladder: LadderWithRungs, rung: LadderRung, sessionId: string, coin: string, markPx: number, fireId: string): Promise<LadderFireResult> {
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

  const fill = await executeIntent(proposal.intent);

  // ATOMICALLY bracket the fill (invariant §3.3). A bracket reject is a hard fault →
  // FLATTEN the just-opened exposure rather than leave it unstopped.
  const filledSize = fill.sz > 0 ? fill.sz : proposal.intent.sz;
  try {
    if (rung.targetPx != null && rung.targetPx > 0) {
      await placeBracketOnHl(coin, proposal.stopPx, rung.targetPx, filledSize, side);
    } else {
      await placeStopOnHl(coin, proposal.stopPx, filledSize, side);
    }
  } catch (bracketErr) {
    // Filled-but-unstopped: flatten immediately (reduce-only). CHECK the flatten result —
    // if the flatten ALSO fails, the position is genuinely unstopped: record a distinct
    // CRITICAL fault (not 'flattened') so it's never mistaken for "safely closed".
    const detail = bracketErr instanceof Error ? bracketErr.message : String(bracketErr);
    let flattenOk = false;
    try {
      const pos = await loadPosition(sessionId, coin);
      if (pos && pos.side !== 'flat' && pos.sz > 0) {
        const closeIntent = buildMarketReduceOnlyClose(pos, { sessionId, clientIntentId: randomUUID(), now: Date.now() });
        if (closeIntent) { await executeIntent(closeIntent); flattenOk = true; }
      } else {
        flattenOk = true; // nothing on the books to flatten (e.g. paper / already flat)
      }
    } catch { flattenOk = false; }
    await setRungStatus(rung.id, 'failed');
    if (flattenOk) {
      await markFireOutcome(fireId, 'flattened', `bracket-reject: ${detail}`);
      await alert(sessionId, `Ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: bracket REJECTED after fill — FLATTENED (filled-but-unstopped fault).`);
      return { fired: false, skipped: 'bracket-reject-flattened', flattened: true };
    }
    await markFireOutcome(fireId, 'failed', `CRITICAL bracket-reject AND flatten-FAILED — UNSTOPPED position: ${detail}`);
    await alert(sessionId, `🚨 Ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: bracket rejected AND flatten FAILED — ${coin} is UNSTOPPED. Manual intervention required.`);
    return { fired: false, skipped: 'bracket-reject-flatten-failed', flattened: false };
  }

  await markFireOutcome(fireId, 'filled');
  await setRungStatus(rung.id, 'fired');
  await writeAnalysisLog({ sessionId, source: 'ladder-fire', severity: 'info', message: `FIRED ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: ${rung.action} ${side} ${filledSize} ${coin} @ ~${markPx} (${ladder.mode}).` }).catch(() => {});
  return { fired: true, skipped: null, fill };
}

/** REDUCE / CLOSE — reduce-only, sized from the live position (can never open/flip). */
async function fireReduce(ladder: LadderWithRungs, rung: LadderRung, sessionId: string, coin: string, fireId: string): Promise<LadderFireResult> {
  const pos = await loadPosition(sessionId, coin);
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
    return skip('no-close-intent');
  }
  const fill = await executeIntent(intent);
  await markFireOutcome(fireId, 'filled');
  await setRungStatus(rung.id, 'fired');
  await writeAnalysisLog({ sessionId, source: 'ladder-fire', severity: 'info', message: `FIRED ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: ${rung.action} ${coin} (frac ${fraction.toFixed(2)}, ${ladder.mode}).` }).catch(() => {});
  return { fired: true, skipped: null, fill };
}
