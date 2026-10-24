/** Production I/O for the shared event straddle template. Never arms or trades. */
import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';
import type { CreateLadderInput } from './ladder-service';
import type { EventStraddlePair, EventStraddlePrepDeps } from './event-straddle-prep-service';

function dbLeg(leg: CreateLadderInput) {
  return {
    title: leg.title, thesis: leg.thesis, author: leg.author, mode: leg.mode,
    oco_group_id: leg.ocoGroupId, active_from: new Date(leg.activeFromMs!).toISOString(),
    expires_at: new Date(leg.expiresAtMs!).toISOString(),
    max_total_notional_usd: leg.maxTotalNotionalUsd,
    max_total_loss_usd: leg.maxTotalLossUsd,
    rungs: leg.rungs.map((r) => ({
      seq: r.seq, coin: r.coin, side: r.side, action: r.action,
      trigger_kind: r.triggerKind, trigger_px: r.triggerPx ?? null,
      trigger_meta: r.triggerMeta ?? null, reduce_frac: r.reduceFrac ?? null,
      risk_usd: r.riskUsd ?? null, stop_frac: r.stopFrac ?? null,
      leverage: r.leverage ?? null,
    })),
  };
}

export const eventStraddlePrepDeps: EventStraddlePrepDeps = {
  async getMid(coin) {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
    });
    if (!response.ok) throw new Error(`mid fetch failed: HTTP ${response.status}`);
    const mids = await response.json() as Record<string, string>;
    const ref = Number(mids[coin]);
    if (!Number.isFinite(ref) || ref <= 0) throw new Error(`no mid for ${coin}`);
    return ref;
  },
  async createPair({ eventId, legs }): Promise<EventStraddlePair> {
    const { data, error } = await getServiceRoleClient().rpc('create_event_straddle_pair', {
      p_event_id: eventId, p_legs: legs.map(dbLeg),
    });
    if (error) throw new Error(`create_event_straddle_pair failed: ${error.message}`);
    if (!data || typeof data !== 'object') throw new Error('create_event_straddle_pair returned no result');
    const row = data as { created?: unknown; ids?: unknown };
    if (typeof row.created !== 'boolean' || !Array.isArray(row.ids) || row.ids.length !== 2 || row.ids.some((id) => typeof id !== 'string')) {
      throw new Error('create_event_straddle_pair returned an invalid result');
    }
    return { created: row.created, ids: row.ids as [string, string] };
  },
  async alertReady({ event, coin, ref, ids, activeFromMs }) {
    await sendDiscord(
      `💡 **${event.name} straddle drafted — ARM DECISION NEEDED**\n` +
      `${coin} ref ${ref}; legs: \`${ids[0].slice(0, 8)}\` (long) + \`${ids[1].slice(0, 8)}\` (short), OCO. ` +
      `Hot from ${new Date(activeFromMs).toISOString().slice(11, 16)} UTC.\n` +
      `Arm BOTH in the cockpit if you want the trade. Drafts do nothing on their own.`,
    );
  },
};
