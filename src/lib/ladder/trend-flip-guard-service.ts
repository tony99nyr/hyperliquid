/**
 * Trend flip guard — DISARM-ONLY enforcement of the 8h-regime dead-zone rule for
 * trend-follow ladders (mirrors the retired leverage lane's `checkLeverageUnwind`
 * regime trigger, and the leader guard's disarm-only pattern).
 *
 * For every ARMED trend-follow ladder: read the iamrossi stance; when the system
 * has LEFT bullish (regime flip) or gone to cash on the coin, the entry thesis is
 * dead → disarmLadder + alert (analysis_log + Discord). The native resting stop
 * keeps protecting any open position; CLOSING stays human. An unreadable stance is
 * "cannot verify" — the guard does nothing (never treats an outage as a flip; the
 * ladder's own expiry is the backstop). Runs from the ladder-watch cron, .catch'd.
 * **This service can never fire, open, or close anything.**
 */

import 'server-only';
import { listLaddersWithRungs, disarmLadder } from './ladder-service';
import { fetchTrendStance, stanceFor, isTrendStanceConfigured, TREND_BULLISH_CONF_MIN, type TrendStance } from './trend-stance-service';
import { isTrendLadderTitle } from './trend-alert-business-logic';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';

export interface TrendFlipGuardSummary {
  checked: number;
  disarmed: { ladderId: string; reason: string }[];
  /** True when armed trend ladders exist but the stance could not be read this tick. */
  stanceUnreadable: boolean;
}


/**
 * A flip = the system is readable and has left the bullish-and-holding state that
 * justified the entry. Confidence merely sagging below the entry bar while still
 * bullish+holding is NOT a flip (the old unwind triggered on regime ≠ bullish only);
 * `enabled=false` (system paused) also counts — an unmanaged signal is a dead thesis.
 */
export function isRegimeFlipped(stance: TrendStance | null): boolean {
  if (stance === null) return false; // unreadable/absent = cannot verify, never a flip
  return !stance.enabled || stance.position === 'cash' || stance.regime !== 'bullish';
}

export async function runTrendFlipGuard(now = Date.now()): Promise<TrendFlipGuardSummary> {
  const summary: TrendFlipGuardSummary = { checked: 0, disarmed: [], stanceUnreadable: false };
  if (!isTrendStanceConfigured()) return summary;

  // ANCHORED per-ladder match (title starts `<COIN> trend-follow `) — the guard holds
  // disarm authority, so a loose substring must never rope in an operator ladder.
  const armed = (await listLaddersWithRungs('armed')).filter((l) =>
    isTrendLadderTitle(l.title, l.rungs[0]?.coin ?? undefined),
  );
  summary.checked = armed.length;
  if (armed.length === 0) return summary;

  const snapshot = await fetchTrendStance(now);
  if (!snapshot) {
    summary.stanceUnreadable = true; // surfaced in the cron summary; no Discord (would spam every 5min tick)
    return summary;
  }

  for (const ladder of armed) {
    const coin = (ladder.rungs[0]?.coin ?? '').toUpperCase();
    if (!coin) continue;
    const stance = stanceFor(snapshot, coin);
    if (!isRegimeFlipped(stance)) continue;

    const why = stance
      ? `8h stance left bullish (now ${stance.regime}/${Math.round(stance.regimeConfidence * 100)}%, ${stance.position}${stance.enabled ? '' : ', system disabled'})`
      : 'stance absent for coin';
    const reason = `trend-flip: ${why}`;
    await disarmLadder(ladder.id, reason);
    summary.disarmed.push({ ladderId: ladder.id, reason });
    const msg =
      `🛑 Ladder ${ladder.id.slice(0, 8)} "${ladder.title}" AUTO-DISARMED — ${reason}. ` +
      `Pending rungs will not fire; any open position keeps its resting stop — REVIEW THE EXIT yourself ` +
      `(the guard never closes). Entry bar was bullish ≥ ${Math.round(TREND_BULLISH_CONF_MIN * 100)}% + holding.`;
    const session = await getActiveSession().catch(() => null);
    if (session) await writeAnalysisLog({ sessionId: session.id, source: 'trend-flip-guard', severity: 'warn', message: msg }).catch(() => {});
    await sendDiscord(msg, 'HL Ladder Guard').catch(() => {});
  }
  return summary;
}
