/**
 * runaway-alert — PURE. The desk doctrine (operator, 2026-08-19): "strong movements ARE
 * a catalyst" — when a coin makes an outsized 24h move, that momentum itself is the
 * opportunity, and a ladder should be IN PLAY for it. Born from the HYPE +19% miss:
 * every layer either couldn't act (rubric penalizes crowded momentum by construction),
 * was too slow (daily htf-trend), or had no drafter watching (nothing owned runaways).
 *
 * Turns a runaway HIT (|24h move| ≥ threshold) into a LOW-QTY LIVE ladder plan shaped
 * for CONTINUATION without chasing the spike:
 *   - ENTRY rests at a SHALLOW PULLBACK toward the move (long → `price_below` a bid
 *     under the mark), momentum-confirmed so it fires on the dip-AND-TURN, not a naked
 *     tag into a reversal knife. Resting below the mark = can't trip the arm-route
 *     instant-fire guard (the reversion lane's lesson).
 *   - ADD + breakeven ratchet fire on a continuation THROUGH the current extreme.
 *   - Profit-take + trail above; SHORT expiry (runaway structure goes stale fast).
 * The cron service creates it as a DRAFT and pings Discord; the operator ARMS it (the
 * human gate — never auto-armed). Ladders are ALWAYS live low-qty, never paper.
 */

import type { CreateLadderInput } from './ladder-service';

export interface RunawayHit {
  coin: string;
  /** WITH the move: an up-runaway drafts a long, a down-runaway a short. */
  side: 'long' | 'short';
  /** Signed 24h move, e.g. +0.19 for +19%. */
  movePct24h: number;
  mark: number;
}

export interface RunawayDetectInput {
  coin: string;
  mark: number;
  prevDayPx: number;
}

/** |24h move| at/above this = a runaway (0.05 = 5%, the operator's bar). */
export const RUNAWAY_MOVE_THRESHOLD = 0.05;

/** PURE detection: an outsized 24h move in either direction. Null when quiet/undefined. */
export function detectRunaway(inp: RunawayDetectInput, threshold: number = RUNAWAY_MOVE_THRESHOLD): RunawayHit | null {
  if (!(inp.mark > 0) || !(inp.prevDayPx > 0)) return null;
  const move = inp.mark / inp.prevDayPx - 1;
  if (Math.abs(move) < threshold) return null;
  return { coin: inp.coin.toUpperCase(), side: move > 0 ? 'long' : 'short', movePct24h: move, mark: inp.mark };
}

export interface RunawayPlanOpts {
  riskUsd?: number; // default 10 — the momentum catalyst warrants more than the fade's 2.5, still low
  leverage?: number; // default 3
  expiryHours?: number; // default 48 — runaway structure decays in days, not weeks
  now: number;
}

const PULLBACK_FRAC = 0.035; // the entry rests 3.5% back toward the move (a shallow dip)
const STOP_FRAC = 0.05; // structural: 5% beyond the pullback entry (runaways retrace hard)
// The add confirms 1.5% THROUGH the detection mark. Was 0.5% — arm latency made it
// stale-by-arm-time on the first live firing (08-21 ETH: price ran through the add
// before the operator could arm → instant-fire refusal, un-armable draft), and the
// panel's technical skeptic had flagged sub-1% adds as inside the noise of the highs.
const CONTINUATION_FRAC = 0.015;
const NOTIONAL_CAP_USD = 300; // bounds risk/stopFrac so the draft stays tiny + armable

/**
 * The pullback-entry geometry — the single source of truth the plan and the Discord
 * message both read. A long runaway rests a BID below the mark (`price_below`, fills on
 * the dip); a short runaway an OFFER above. Stop is STOP_FRAC beyond the entry. PURE.
 */
export function runawayEntry(hit: RunawayHit): {
  entryKind: 'price_above' | 'price_below';
  entryPx: number;
  stopPx: number;
  stopFrac: number;
} {
  const isShort = hit.side === 'short';
  const entryKind: 'price_above' | 'price_below' = isShort ? 'price_above' : 'price_below';
  const entryPx = isShort ? hit.mark * (1 + PULLBACK_FRAC) : hit.mark * (1 - PULLBACK_FRAC);
  const stopPx = isShort ? entryPx * (1 + STOP_FRAC) : entryPx * (1 - STOP_FRAC);
  return { entryKind, entryPx, stopPx, stopFrac: STOP_FRAC };
}

/** Build the LIVE draft ladder for a runaway continuation. PURE + fixture-tested. */
export function buildRunawayLadderPlan(hit: RunawayHit, opts: RunawayPlanOpts): CreateLadderInput {
  const leverage = opts.leverage ?? 3;
  const expiryHours = opts.expiryHours ?? 48;
  const { entryKind, entryPx, stopPx, stopFrac } = runawayEntry(hit);
  const riskUsd = Math.min(opts.riskUsd ?? 10, NOTIONAL_CAP_USD * stopFrac);
  const isShort = hit.side === 'short';
  // Profit direction: a long profits as price RISES (price_above), a short as it falls.
  const profitKind: 'price_above' | 'price_below' = isShort ? 'price_below' : 'price_above';
  // The continuation level: through the pre-draft extreme (the mark at detection).
  const contPx = isShort ? hit.mark * (1 - CONTINUATION_FRAC) : hit.mark * (1 + CONTINUATION_FRAC);
  // Targets measured in R from the pullback entry.
  const r = entryPx * stopFrac;
  const t2 = isShort ? entryPx - 2 * r : entryPx + 2 * r;
  const trailDistancePx = Math.max(hit.mark * 0.02, 1e-6);
  const round = (x: number): number => Number(x.toFixed(6));
  const pct = (hit.movePct24h * 100).toFixed(1);

  return {
    title: `${hit.coin} runaway ${hit.side} — ${hit.movePct24h > 0 ? '+' : ''}${pct}% 24h (auto-draft · review+arm)`,
    thesis:
      `AUTO-DRAFTED from a RUNAWAY hit: ${hit.coin} moved ${hit.movePct24h > 0 ? '+' : ''}${pct}% in 24h ` +
      `(mark ${round(hit.mark)} at detection). Doctrine: strong movement IS a catalyst — continuation ${hit.side}, ` +
      `entered WITHOUT chasing: a momentum-confirmed ${entryKind === 'price_below' ? 'bid' : 'offer'} rests at the ` +
      `${(PULLBACK_FRAC * 100).toFixed(1)}% pullback (${round(entryPx)}) and fires on the dip-AND-TURN, never a naked tag. ` +
      `Stop ${round(stopPx)} (${(STOP_FRAC * 100).toFixed(0)}% structural), add + breakeven ratchet on continuation through ` +
      `${round(contPx)}, bank 40% at +2R (${round(t2)}), trail after. UNPROVEN discretionary shape — sized LOW ` +
      `(~$${riskUsd} risk), panel-gate before arming. ${expiryHours}h expiry (runaway structure goes stale fast).`,
    author: 'operator',
    mode: 'live',
    maxTotalLossUsd: Math.max(20, Math.ceil((riskUsd / stopFrac) * 0.25)),
    maxTotalNotionalUsd: Math.ceil(NOTIONAL_CAP_USD * 1.6), // core + half-size add headroom
    expiresAtMs: opts.now + expiryHours * 60 * 60 * 1000,
    rungs: [
      {
        // ENTRY: momentum-confirmed pullback. The confirm makes it fire on the first
        // completed candle at/below the level with CLEAN momentum — the turn, not the knife.
        seq: 1, coin: hit.coin, side: hit.side, action: 'open', triggerKind: entryKind, triggerPx: round(entryPx),
        riskUsd, stopFrac, leverage, triggerMeta: { momentumConfirm: true },
      },
      // CONTINUATION add (half risk) + breakeven ratchet at the same level: only pay up
      // when the move proves itself through the detection extreme.
      {
        seq: 2, coin: hit.coin, side: hit.side, action: 'add', triggerKind: profitKind, triggerPx: round(contPx),
        riskUsd: round(riskUsd / 2), stopFrac, leverage, triggerMeta: { momentumConfirm: true },
      },
      { seq: 3, coin: hit.coin, side: hit.side, action: 'stop_move', triggerKind: profitKind, triggerPx: round(contPx), triggerMeta: { moveTo: 'breakeven' } },
      { seq: 4, coin: hit.coin, side: hit.side, action: 'reduce', triggerKind: profitKind, triggerPx: round(t2), reduceFrac: 0.4 },
      { seq: 5, coin: hit.coin, side: hit.side, action: 'stop_move', triggerKind: profitKind, triggerPx: round(t2), triggerMeta: { moveTo: 'trail', trailDistancePx: round(trailDistancePx) } },
    ],
  };
}

/** The Discord nudge for a fresh runaway draft. PURE (caller sends). Quotes the SAME
 *  entry/stop the rungs use (via runawayEntry) so the alert never desyncs from the plan. */
export function runawayAlertMessage(hit: RunawayHit, ladderId: string, cockpitBaseUrl?: string): string {
  const link = cockpitBaseUrl ? `\n👉 ${cockpitBaseUrl.replace(/\/$/, '')}/cockpit?tab=ladders` : '';
  const { entryPx, stopPx } = runawayEntry(hit);
  const pct = (hit.movePct24h * 100).toFixed(1);
  const restVerb = hit.side === 'short' ? 'an offer above' : 'a bid below';
  return (
    `🚀 **Runaway ${hit.side.toUpperCase()} candidate — ${hit.coin} ${hit.movePct24h > 0 ? '+' : ''}${pct}% in 24h**\n` +
    `Strong movement IS a catalyst: auto-drafted LIVE low-qty ladder \`${ladderId.slice(0, 8)}\` — ${restVerb} the mark ` +
    `at ${entryPx.toFixed(4)} (momentum-confirmed pullback entry, no chasing), stop ${stopPx.toFixed(4)}, continuation ` +
    `add + breakeven above, +2R bank + trail. UNPROVEN shape — **panel-gate, then review + arm in the cockpit** ` +
    `(48h expiry; nothing fires until you arm).${link}`
  );
}
