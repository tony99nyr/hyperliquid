/** Shared manual and cron straddle preparation. The database inserts both drafts atomically. */
import { randomUUID } from 'node:crypto';
import type { EconEvent } from '@/lib/skills/economic-events';
import type { CreateLadderInput, NewRung } from './ladder-service';

export interface EventStraddlePair {
  created: boolean;
  ids: [string, string];
}

export interface EventStraddlePrepDeps {
  getMid(coin: string): Promise<number>;
  createPair(input: { eventId: string; legs: [CreateLadderInput, CreateLadderInput] }): Promise<EventStraddlePair>;
  alertReady(input: { event: EconEvent; coin: string; ref: number; ids: [string, string]; activeFromMs: number }): Promise<void>;
}

export interface PrepOptions {
  event: EconEvent;
  now: number;
  coin?: string;
  gatePct?: number;
  riskUsd?: number;
  dry?: boolean;
}

function nudgeOffRound(px: number, dir: 1 | -1): number {
  const step = px >= 10_000 ? 500 : px >= 1_000 ? 50 : px >= 100 ? 5 : px >= 10 ? 0.5 : 0.05;
  const nearest = Math.round(px / step) * step;
  const out = Math.abs(px - nearest) < 0.0015 * px ? nearest + dir * 0.002 * px : px;
  return Number(out.toFixed(px >= 1_000 ? 0 : px >= 10 ? 2 : 4));
}

export function buildEventStraddle(
  options: PrepOptions,
  ref: number,
  ocoGroupId: string,
): { eventId: string; legs: [CreateLadderInput, CreateLadderInput]; activeFromMs: number } {
  const { event, now } = options;
  if (!Number.isFinite(ref) || ref <= 0) throw new Error('invalid pre-print reference');
  if (!Number.isFinite(now)) throw new Error('invalid prep time');
  const printAtMs = Date.parse(event.atIso);
  if (!Number.isFinite(printAtMs)) throw new Error('invalid print time');
  const coin = (options.coin ?? event.straddleCoin ?? 'BTC').trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(coin)) throw new Error('invalid straddle coin');
  const gatePct = options.gatePct ?? (coin === 'HYPE' || coin === 'SOL' ? 0.015 : 0.01);
  const riskUsd = options.riskUsd ?? 4;
  if (!Number.isFinite(gatePct) || gatePct <= 0 || gatePct >= 0.1) throw new Error('invalid gate percentage');
  if (!Number.isFinite(riskUsd) || riskUsd <= 0) throw new Error('invalid risk');
  const activeFromMs = printAtMs - 15 * 60_000;
  const expiresAtMs = printAtMs + 24 * 60 * 60_000;
  const pxDp = ref >= 1_000 ? 0 : ref >= 10 ? 2 : 4;
  const legs = (['long', 'short'] as const).map((side): CreateLadderInput => {
    const dir: 1 | -1 = side === 'long' ? 1 : -1;
    const gate = nudgeOffRound(ref * (1 + dir * gatePct), dir);
    const stopFrac = Number((Math.abs(gate - ref) / gate).toFixed(4));
    if (stopFrac <= 0) throw new Error('gate rounds onto reference');
    const kind = side === 'long' ? 'price_above' : 'price_below';
    const lvl = (r: number) => nudgeOffRound(gate * (1 + dir * gatePct * r), dir);
    const rungs: NewRung[] = [
      { seq: 1, coin, side, action: 'open', triggerKind: kind, triggerPx: gate, riskUsd, stopFrac, leverage: 2 },
      { seq: 2, coin, side, action: 'stop_move', triggerKind: kind, triggerPx: lvl(0.7), triggerMeta: { moveTo: 'breakeven' } },
      { seq: 3, coin, side, action: 'reduce', triggerKind: kind, triggerPx: lvl(1), reduceFrac: 0.34 },
      { seq: 4, coin, side, action: 'reduce', triggerKind: kind, triggerPx: lvl(2), reduceFrac: 0.5 },
      { seq: 5, coin, side, action: 'stop_move', triggerKind: kind, triggerPx: lvl(1.2), triggerMeta: { moveTo: 'trail', trailDistancePx: Number((gate * gatePct * 0.8).toFixed(pxDp)) } },
      { seq: 6, coin, side, action: 'reduce', triggerKind: 'indicator', reduceFrac: 0.5, triggerMeta: { op: 'above', indicatorName: `momentum-stall-${side}`, indicatorValue: 2 } },
    ];
    const worst = riskUsd * (0.9 + 0.1 / stopFrac);
    return {
      title: `${coin} ${event.name} straddle — ${side} leg (event template)`,
      thesis:
        `Event-straddle template (graduated 2026-07-14) on ${event.name}, print ${event.atIso}. ` +
        `Pre-print reference ${ref} measured at build time ${new Date(now).toISOString()}; gate ${gate} ` +
        `(${(gatePct * 100).toFixed(1)}% ${side === 'long' ? 'above' : 'below'}), stop at the reference (1R = gate distance). ` +
        `Jul-15 lessons built in: breakeven ratchet at +0.7R, banks +1R/+2R, momentum stall-exit ≥2 with NO floor ` +
        `(event fills are fade-prone — cut the fade even slightly underwater). Plain OCO — first fire disarms the sibling; ` +
        `if the fired side STOPS OUT, re-present the sibling (standing order, ~30% conditional whipsaw). ` +
        `Window: hot from print−15min, expires print+24h. Remainder after banks is a manual time-exit at the next checkpoint.`,
      author: 'operator', mode: 'live', ocoGroupId, activeFromMs, expiresAtMs,
      maxTotalNotionalUsd: Math.ceil((riskUsd / stopFrac) * 1.15),
      maxTotalLossUsd: Math.ceil(worst * 1.15), rungs,
    };
  }) as [CreateLadderInput, CreateLadderInput];
  // The print instant is shared by the cron and a manual command, even if their
  // labels differ. One pair per instant also avoids duplicate live OCO plans.
  return { eventId: new Date(printAtMs).toISOString(), legs, activeFromMs };
}

export async function prepEventStraddle(options: PrepOptions, deps: EventStraddlePrepDeps): Promise<EventStraddlePair | { dry: true }> {
  const printAtMs = Date.parse(options.event.atIso);
  const leadMs = (options.event.prepLeadMinutes ?? 30) * 60_000;
  if (!options.dry && (!Number.isFinite(printAtMs) || options.now < printAtMs - leadMs || options.now >= printAtMs)) {
    throw new Error('outside prep window');
  }
  const coin = (options.coin ?? options.event.straddleCoin ?? 'BTC').trim().toUpperCase();
  const ref = await deps.getMid(coin);
  const pair = buildEventStraddle(options, ref, randomUUID());
  if (options.dry) return { dry: true };
  const result = await deps.createPair(pair);
  if (result.created) await deps.alertReady({ event: options.event, coin, ref, ids: result.ids, activeFromMs: pair.activeFromMs });
  return result;
}
