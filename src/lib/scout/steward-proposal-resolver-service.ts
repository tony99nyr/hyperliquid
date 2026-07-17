/**
 * Steward proposal resolver (I/O) — runs from the production ladder-watch tick
 * (always on, PC-sleep-proof) and scores due proposals: due = the referenced
 * position has gone FLAT, or the 24h horizon passed. Pages Discord 📊 with the
 * verdict so the operator wakes up to "would it have helped: +$X / −$X", not a
 * mystery. Fail-soft everywhere; read-only on the market; writes only its own
 * ledger. The approximation is honest and recorded: when the position closed
 * before the horizon, the actual reference is the mark at DETECTION (a ~2-min
 * cron granularity), not the exact fill — noted in the row.
 */

import 'server-only';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchAllMids, fetchClearinghouseState } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { sendDiscord } from '@/lib/infrastructure/notify/discord-notify';
import { resolveProposalCounterfactual } from './steward-proposal-business-logic';

export interface StewardResolveSummary {
  checked: number;
  resolved: number;
}

interface OpenProposalRow {
  id: string;
  created_at: string;
  coin: string;
  title: string;
  proposal_kind: 'exit' | 'bank' | 'stop-tighten' | 'disarm' | 'widen-target' | 'info';
  side: 'long' | 'short' | null;
  position_sz: number | null;
  mark_px: number | null;
  param_px: number | null;
  horizon_at: string;
}

export async function resolveStewardProposals(now = Date.now()): Promise<StewardResolveSummary> {
  try {
    const client = getServiceRoleClient();
    const { data, error } = await client
      .from('steward_proposals')
      .select('id, created_at, coin, title, proposal_kind, side, position_sz, mark_px, param_px, horizon_at')
      .eq('status', 'open')
      .limit(20);
    if (error || !data || data.length === 0) return { checked: 0, resolved: 0 };

    const addr = getHlAccountAddress();
    const [mids, ch] = await Promise.all([
      fetchAllMids().catch(() => ({}) as Record<string, string>),
      addr ? fetchClearinghouseState(addr).catch(() => null) : Promise.resolve(null),
    ]);
    const openCoins = new Set((ch?.positions ?? []).filter((p) => p.size > 0).map((p) => p.coin.toUpperCase()));

    let resolved = 0;
    for (const raw of data as OpenProposalRow[]) {
      const coin = raw.coin.toUpperCase();
      const horizonDue = now >= Date.parse(raw.horizon_at);
      // Due when the referenced position is flat (the trade concluded) or the
      // horizon passed. A proposal that referenced no position resolves at horizon.
      const positionGone = raw.side !== null && ch !== null && !openCoins.has(coin);
      if (!horizonDue && !positionGone) continue;

      const actualRefPx = Number(mids[coin]);
      let candles: Array<{ highPx: number; lowPx: number }> = [];
      if (raw.proposal_kind === 'stop-tighten') {
        try {
          const res = await fetchCandles(coin, '15m', Date.parse(raw.created_at), now);
          candles = res.candles.slice(0, -1).map((c) => ({ highPx: c.high, lowPx: c.low }));
        } catch {
          /* replay unavailable → the pure fn scores what it can */
        }
      }
      const cf = resolveProposalCounterfactual(
        {
          proposalKind: raw.proposal_kind,
          side: raw.side,
          positionSz: raw.position_sz,
          markPx: raw.mark_px,
          paramPx: raw.param_px,
        },
        candles,
        actualRefPx,
      );
      const basis = positionGone ? 'position closed (mark at detection ≈ exit)' : '24h horizon';
      await client
        .from('steward_proposals')
        .update({
          status: cf.scorable ? 'resolved' : 'unscorable',
          resolved_at: new Date(now).toISOString(),
          cf_exit_px: cf.cfExitPx,
          actual_ref_px: Number.isFinite(actualRefPx) ? actualRefPx : null,
          helped_usd: cf.helpedUsd,
          resolution_note: `${cf.note} · basis: ${basis}`,
        })
        .eq('id', raw.id)
        .eq('status', 'open');
      resolved++;
      if (cf.scorable && cf.helpedUsd != null) {
        const emoji = cf.helpedUsd > 0 ? '📊✅' : cf.helpedUsd < 0 ? '📊❌' : '📊➖';
        await sendDiscord(
          `${emoji} **STEWARD COUNTERFACTUAL** — "${raw.title.slice(0, 80)}" (${coin} ${raw.proposal_kind}): ` +
            `acting on it would have ${cf.helpedUsd > 0 ? `HELPED +$${cf.helpedUsd.toFixed(2)}` : cf.helpedUsd < 0 ? `HURT −$${Math.abs(cf.helpedUsd).toFixed(2)}` : 'changed nothing'} ` +
            `(${cf.note}; ${basis}).`,
          'HL Ladder Steward',
        ).catch(() => {});
      }
    }
    return { checked: data.length, resolved };
  } catch {
    return { checked: 0, resolved: 0 };
  }
}
