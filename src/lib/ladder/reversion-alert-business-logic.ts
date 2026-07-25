/**
 * reversion-alert — PURE. Turns a reversion-extreme scan HIT into a LOW-QTY LIVE
 * ladder plan (a fade: enter on the roll-over, stop beyond the extreme, take profit
 * at the mean). The cron service creates it as a DRAFT and pings Discord; the operator
 * still ARMS it (the human gate — we never auto-arm). Ladders are ALWAYS live low-qty,
 * never paper (see the no-paper-ladders rule). Kept pure so the plan is deterministic
 * + fixture-tested.
 */

import type { CreateLadderInput } from './ladder-service';

/** The subset of a reversion scan hit this needs. */
export interface ReversionAlertHit {
  coin: string;
  side: 'long' | 'short'; // the FADE direction (long = fade a down-stretch)
  z: number;
  er: number;
  regime: string;
  regimeConf: number;
  mark: number;
  stop: number;
  target: number;
  stopFrac: number;
}

export interface ReversionPlanOpts {
  riskUsd?: number; // default 2.5 — LOW (discipline protects, not paper)
  leverage?: number; // default 3
  expiryHours?: number; // default 12 (reversion is a fast signal — a stale draft auto-expires)
  now: number;
}

const clampFrac = (f: number): number => (Number.isFinite(f) && f > 0.005 ? Math.min(f, 0.12) : 0.03);

/**
 * Build the LIVE draft ladder for a reversion fade. Trigger direction is the PROFIT
 * side (short → price_below, long → price_above), so the entry fires as price ticks
 * back toward the mean and `momentumConfirm` gates it on the roll-over (won't fade a
 * stretch that keeps extending). Stop = the signal's stop (beyond the extreme); T1 =
 * the mean (target); then breakeven + trail on the runner. PURE.
 */
export function buildReversionLadderPlan(hit: ReversionAlertHit, opts: ReversionPlanOpts): CreateLadderInput {
  const riskUsd = opts.riskUsd ?? 2.5;
  const leverage = opts.leverage ?? 3;
  const expiryHours = opts.expiryHours ?? 12;
  const stopFrac = clampFrac(hit.stopFrac);
  const mark = hit.mark;
  const target = hit.target;
  const isShort = hit.side === 'short';
  // The profit-direction trigger: a short profits as price FALLS (price_below), a long
  // as it RISES (price_above). Entry, breakeven, TP + trail all fire on that side.
  const profitKind: 'price_above' | 'price_below' = isShort ? 'price_below' : 'price_above';
  // Enter a hair past the mark, confirming the turn (not at the exact extreme).
  const entryPx = isShort ? mark * 0.999 : mark * 1.001;
  const halfPx = (mark + target) / 2; // breakeven once it's halfway to the mean
  const trailDistancePx = Math.max(mark * 0.015, 1e-6);

  const round = (x: number): number => Number(x.toFixed(6));

  return {
    title: `${hit.coin} reversion-fade ${hit.side} — z=${hit.z.toFixed(1)} (auto-draft · review+arm)`,
    thesis:
      `AUTO-DRAFTED from a reversion-extreme scan hit: |z|=${Math.abs(hit.z).toFixed(2)} stretch, ` +
      `efficiency ${hit.er.toFixed(2)} (range), 4h regime ${hit.regime}/${Math.round(hit.regimeConf * 100)}%. ` +
      `FADE ${hit.side} the dislocation: enter on the roll-over (momentumConfirm), stop ${round(hit.stop)} ` +
      `(beyond the extreme), take profit into the mean ${round(target)}. Reversion is the ONE forward-testing ` +
      `edge (NOT yet graduated) — sized LOW (~${riskUsd} risk). LIVE low-qty draft; the operator ARMS it. ` +
      `Short shelf-life (${expiryHours}h expiry) — reversion is fast.`,
    author: 'operator',
    mode: 'live',
    maxTotalLossUsd: Math.max(6, Math.ceil(riskUsd * 5)),
    maxTotalNotionalUsd: Math.ceil((riskUsd / stopFrac) * 1.3),
    expiresAtMs: opts.now + expiryHours * 60 * 60 * 1000,
    rungs: [
      {
        seq: 1, coin: hit.coin, side: hit.side, action: 'open', triggerKind: profitKind, triggerPx: round(entryPx),
        riskUsd, stopFrac, leverage, triggerMeta: { momentumConfirm: true, momentumSustain: 2, momentumMaxFlips: 0 },
      },
      { seq: 2, coin: hit.coin, side: hit.side, action: 'stop_move', triggerKind: profitKind, triggerPx: round(halfPx), triggerMeta: { moveTo: 'breakeven' } },
      { seq: 3, coin: hit.coin, side: hit.side, action: 'reduce', triggerKind: profitKind, triggerPx: round(target), reduceFrac: 0.6 },
      { seq: 4, coin: hit.coin, side: hit.side, action: 'stop_move', triggerKind: profitKind, triggerPx: round(target), triggerMeta: { moveTo: 'trail', trailDistancePx: round(trailDistancePx) } },
    ],
  };
}

/** The Discord nudge for a fresh reversion draft. PURE (caller sends it). */
export function reversionAlertMessage(hit: ReversionAlertHit, ladderId: string): string {
  return (
    `🔁 **Reversion fade candidate — ${hit.coin} ${hit.side.toUpperCase()}** (|z|=${Math.abs(hit.z).toFixed(1)}, ` +
    `regime ${hit.regime}/${Math.round(hit.regimeConf * 100)}%)\n` +
    `Auto-drafted a LIVE low-qty ladder \`${ladderId.slice(0, 8)}\` — fade to the mean ${hit.target.toFixed(4)}, ` +
    `stop ${hit.stop.toFixed(4)}. Reversion is the forward-testing edge (unproven) — **review + arm in the cockpit** ` +
    `if you like it (12h expiry; nothing fires until you arm).`
  );
}
