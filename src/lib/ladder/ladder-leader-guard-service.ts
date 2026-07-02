/**
 * Leader guard service — DISARM-ONLY enforcement of the copy-thesis dead-zone rule.
 *
 * For every ARMED ladder tagged with a leader_address, read the trader-watch feed
 * (leader_positions live-book mirror + leader_actions events) and, when the PURE verdict
 * says the leader closed/flipped the coin after arming, disarmLadder + alert (analysis_log
 * + Discord). Runs from the ladder-watch cron route each tick, .catch'd — a guard failure
 * must never break the watcher. **This service can never fire, open, or close anything.**
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { listLaddersWithRungs, disarmLadder } from './ladder-service';
import { leaderGuardVerdict, type LeaderActionRow, type LeaderPositionRow } from './ladder-leader-guard-business-logic';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { getActiveSession } from '@/lib/cockpit/session-service';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';

/** Positions older than this don't prove coverage (the trader-watch cadence is minutes). */
const MAX_FEED_AGE_MS = 30 * 60_000;
/** Only actions this recent are fetched (the exit must postdate arming anyway). */
const ACTION_LOOKBACK_MS = 7 * 24 * 3_600_000;

export interface LeaderGuardSummary {
  checked: number;
  disarmed: { ladderId: string; reason: string }[];
}

export async function runLeaderGuard(now = Date.now()): Promise<LeaderGuardSummary> {
  const armed = (await listLaddersWithRungs('armed')).filter((l) => l.leaderAddress);
  const summary: LeaderGuardSummary = { checked: armed.length, disarmed: [] };
  if (armed.length === 0) return summary;

  const db = getServiceRoleClient();
  const addresses = [...new Set(armed.map((l) => (l.leaderAddress as string).toLowerCase()))];

  const [posRes, actRes] = await Promise.all([
    db.from('leader_positions').select('leader_address,coin,side,updated_at').in('leader_address', addresses),
    db.from('leader_actions').select('leader_address,coin,kind,detected_at').in('leader_address', addresses)
      .gte('detected_at', new Date(now - ACTION_LOOKBACK_MS).toISOString()),
  ]);
  if (posRes.error) throw new Error(`leader guard positions read failed: ${posRes.error.message}`);
  if (actRes.error) throw new Error(`leader guard actions read failed: ${actRes.error.message}`);

  const posByLeader = new Map<string, LeaderPositionRow[]>();
  for (const r of posRes.data ?? []) {
    const key = (r.leader_address as string).toLowerCase();
    (posByLeader.get(key) ?? posByLeader.set(key, []).get(key)!).push({
      coin: r.coin as string,
      side: r.side as 'long' | 'short',
      updatedAtMs: Date.parse(r.updated_at as string),
    });
  }
  const actByLeader = new Map<string, LeaderActionRow[]>();
  for (const r of actRes.data ?? []) {
    const key = (r.leader_address as string).toLowerCase();
    (actByLeader.get(key) ?? actByLeader.set(key, []).get(key)!).push({
      coin: r.coin as string,
      kind: r.kind as LeaderActionRow['kind'],
      atMs: Date.parse(r.detected_at as string),
    });
  }

  for (const ladder of armed) {
    const leader = (ladder.leaderAddress as string).toLowerCase();
    const coin = (ladder.rungs[0]?.coin ?? '').toUpperCase();
    const side = ladder.rungs.find((r) => r.action === 'open')?.side ?? ladder.rungs[0]?.side ?? 'long';
    const armedAtMs = Date.parse(ladder.armedAt ?? ladder.createdAt);
    if (!coin || !Number.isFinite(armedAtMs)) continue;

    const verdict = leaderGuardVerdict({
      coin,
      side,
      armedAtMs,
      positions: posByLeader.get(leader) ?? [],
      actions: actByLeader.get(leader) ?? [],
      maxFeedAgeMs: MAX_FEED_AGE_MS,
      now,
    });
    if (!verdict.shouldDisarm || !verdict.reason) continue;

    await disarmLadder(ladder.id, verdict.reason);
    summary.disarmed.push({ ladderId: ladder.id, reason: verdict.reason });
    const msg = `🛑 Ladder ${ladder.id.slice(0, 8)} "${ladder.title}" AUTO-DISARMED — ${verdict.reason}. Pending rungs will not fire; any open position keeps its resting stop. Review + re-arm only with a fresh thesis.`;
    const session = await getActiveSession().catch(() => null);
    if (session) await writeAnalysisLog({ sessionId: session.id, source: 'ladder-leader-guard', severity: 'warn', message: msg }).catch(() => {});
    await sendDiscord(msg, 'HL Ladder Guard').catch(() => {});
  }
  return summary;
}
