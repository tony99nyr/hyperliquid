/** Stop-move execution for a claimed ladder rung. The caller owns the guard stack. */
import type { Position } from '@/types/position';
import type { LadderFireResult } from './ladder-fire-service';
import type { LadderRung, LadderWithRungs } from './ladder-types';
import { markFireOutcome, setRungStatus, markLadderDone } from './ladder-service';
import { placeStopOnHl, findOpenStop, cancelStopOnHl } from '@/lib/trading/stop-order-service';
import { setAdvisoryStop } from '@/lib/scout/scout-watch-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';

interface StopMoveDeps {
  loadEffectivePosition: (sessionId: string, coin: string, forcePaper: boolean) => Promise<Position | null>;
  alert: (sessionId: string, message: string) => Promise<void>;
}

const skip = (reason: string): LadderFireResult => ({ fired: false, skipped: reason });

/**
 * STOP_MOVE — ratchet the position's RESTING stop to triggerMeta.moveTo. RISK-REDUCING
 * ONLY, enforced live at fire: the new stop must be tighter than the current one and on
 * the protective side of the fresh mark. Ordering is place-NEW-then-cancel-OLD so the
 * position is never unstopped mid-move (both stops are reduce-only; a brief overlap is
 * harmless, an unstopped gap is not). Paper ladders simulate by updating the advisory
 * stop column. Never places an entry/exit order.
 */
export async function fireStopMove(ladder: LadderWithRungs, rung: LadderRung, sessionId: string, coin: string, fireId: string, forcePaper: boolean, markPx: number, deps: StopMoveDeps): Promise<LadderFireResult> {
  let pos: Position | null;
  try {
    pos = await deps.loadEffectivePosition(sessionId, coin, forcePaper);
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
  let newStopOid: number | null = null;
  try {
    const placed = await placeStopOnHl(coin, newStop, pos.sz, pos.side);
    if (!placed.pushed) throw new Error('placeStopOnHl not pushed');
    newStopOid = placed.oid;
  } catch (e) {
    await markFireOutcome(fireId, 'failed', `stop-place-failed: ${e instanceof Error ? e.message : String(e)}`);
    await setRungStatus(rung.id, 'failed');
    await deps.alert(sessionId, `Ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: stop_move FAILED to place the new ${coin} stop @ ${newStop} — the OLD stop still rests (position protected; ratchet lost).`);
    return skip('stop-place-failed');
  }
  if (oldStop?.oid != null) {
    try {
      await cancelStopOnHl(coin, oldStop.oid);
    } catch {
      // Both stops rest (both reduce-only — the tighter one governs economically).
      // Not a fault; page the operator to clean up the stale order.
      await deps.alert(sessionId, `Ladder ${ladder.id.slice(0, 8)} rung ${rung.seq}: new ${coin} stop @ ${newStop} placed but the OLD stop (oid ${oldStop.oid}) failed to cancel — cancel it manually; the tighter stop governs.`);
    }
  }
  await markFireOutcome(fireId, 'filled', JSON.stringify({ stopOid: newStopOid, stopPx: newStop, oldStopOid: oldStop?.oid ?? null })).catch(() => {});
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

