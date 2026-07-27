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

// Notional is bounded downstream, so a TIGHT signal stop is safe to keep — only floor a
// degenerate (near-zero / non-finite) frac and cap a runaway one. Keeping the signal's real
// stop (often 0.4–0.8% beyond the extreme) is what gives a fade its 2:1-ish R:R to the mean;
// the old floor-to-3% widened every tight fade into a bad-R:R trade AND desynced the alert
// (which quoted the raw stop) from the rung (which used 3%).
const clampFrac = (f: number): number => (Number.isFinite(f) && f > 0.003 ? Math.min(f, 0.12) : 0.03);

const ENTRY_BUFFER = 0.001; // rest the entry 0.1% INTO the dislocation (below mark for a long)

/**
 * The resting-limit geometry for a fade — the SINGLE source of truth the plan and the
 * Discord message both read (so the quoted stop always equals the rung's stop). A fade
 * rests a limit INTO the dislocation, not a chase past the mark: a long fade (down-stretch)
 * rests a BID just BELOW the mark (`price_below`) so it fills on further weakness at a
 * better price; a short fade rests an OFFER just ABOVE (`price_above`). Stop is the
 * signal's stopFrac beyond the entry. PURE.
 */
export function reversionEntry(hit: ReversionAlertHit): {
  entryKind: 'price_above' | 'price_below';
  entryPx: number;
  stopPx: number;
  stopFrac: number;
} {
  const stopFrac = clampFrac(hit.stopFrac);
  const isShort = hit.side === 'short';
  const entryKind: 'price_above' | 'price_below' = isShort ? 'price_above' : 'price_below';
  const entryPx = isShort ? hit.mark * (1 + ENTRY_BUFFER) : hit.mark * (1 - ENTRY_BUFFER);
  const stopPx = isShort ? entryPx * (1 + stopFrac) : entryPx * (1 - stopFrac);
  return { entryKind, entryPx, stopPx, stopFrac };
}

/**
 * Build the LIVE draft ladder for a reversion fade. The ENTRY is a resting LIMIT into the
 * dislocation (long → `price_below` a bid under the mark, short → `price_above` an offer
 * over it) — a genuine resting order that survives the operator's review latency and can't
 * trip the arm-route instant-fire guard (unlike the old "chase 0.1% past the mark" entry,
 * which a fast reversion crossed before the human could arm). The WIN-side rungs (breakeven,
 * TP, trail) fire on the profit direction. Stop = the signal's stopFrac beyond the entry;
 * T1 = the mean (target). PURE.
 */
export function buildReversionLadderPlan(hit: ReversionAlertHit, opts: ReversionPlanOpts): CreateLadderInput {
  const leverage = opts.leverage ?? 3;
  const expiryHours = opts.expiryHours ?? 12;
  const { entryKind, entryPx, stopFrac } = reversionEntry(hit);
  // BOUND THE NOTIONAL, not just the risk. A reversion stop can be very TIGHT (small
  // stopFrac); a fixed riskUsd then balloons the notional (riskUsd/stopFrac) and the
  // slip-aware worst case blows past the loss cap so the ladder can NEVER arm. Cap the
  // notional so the position stays genuinely tiny + ARMABLE regardless of stop tightness:
  // riskUsd = min(desired, NOTIONAL_CAP × stopFrac) ⇒ notional ≤ NOTIONAL_CAP.
  const NOTIONAL_CAP_USD = 100;
  const riskUsd = Math.min(opts.riskUsd ?? 2.5, NOTIONAL_CAP_USD * stopFrac);
  const target = hit.target;
  const isShort = hit.side === 'short';
  // The WIN-side trigger: a short profits as price FALLS (price_below), a long as it RISES
  // (price_above). Breakeven, TP + trail all fire on that side.
  const profitKind: 'price_above' | 'price_below' = isShort ? 'price_below' : 'price_above';
  const halfPx = (entryPx + target) / 2; // breakeven once it's halfway from entry to the mean
  const trailDistancePx = Math.max(hit.mark * 0.015, 1e-6);

  const round = (x: number): number => Number(x.toFixed(6));

  return {
    title: `${hit.coin} reversion-fade ${hit.side} — z=${hit.z.toFixed(1)} (auto-draft · review+arm)`,
    thesis:
      `AUTO-DRAFTED from a reversion-extreme scan hit: |z|=${Math.abs(hit.z).toFixed(2)} stretch, ` +
      `efficiency ${hit.er.toFixed(2)} (range), 4h regime ${hit.regime}/${Math.round(hit.regimeConf * 100)}%. ` +
      `FADE ${hit.side} the dislocation: rest a LIMIT into it (${entryKind === 'price_below' ? 'bid below' : 'offer above'} ` +
      `${round(entryPx)}, fills on a better price), stop ${round(reversionEntry(hit).stopPx)} (beyond the extreme), ` +
      `take profit into the mean ${round(target)}. Reversion is the ONE forward-testing edge (NOT yet graduated) — ` +
      `sized LOW (~${riskUsd} risk). LIVE low-qty draft; the operator ARMS it. ` +
      `Short shelf-life (${expiryHours}h expiry) — reversion is fast.`,
    author: 'operator',
    mode: 'live',
    // The slip-aware worst case scales with NOTIONAL (a tight stop + 10% slip model makes
    // the tail ~15% of notional), NOT with the tiny intended riskUsd — so size the cap off
    // the bounded notional or the arm gate false-blocks (min 15 covers the ≤$100 notional).
    maxTotalLossUsd: Math.max(15, Math.ceil((riskUsd / stopFrac) * 0.2)),
    maxTotalNotionalUsd: NOTIONAL_CAP_USD + 20,
    expiresAtMs: opts.now + expiryHours * 60 * 60 * 1000,
    rungs: [
      {
        // ENTRY: resting limit INTO the dislocation. No momentumConfirm — that's a breakout/
        // roll-over filter; a limit into weakness is the opposite shape and fills on price.
        seq: 1, coin: hit.coin, side: hit.side, action: 'open', triggerKind: entryKind, triggerPx: round(entryPx),
        riskUsd, stopFrac, leverage,
      },
      { seq: 2, coin: hit.coin, side: hit.side, action: 'stop_move', triggerKind: profitKind, triggerPx: round(halfPx), triggerMeta: { moveTo: 'breakeven' } },
      { seq: 3, coin: hit.coin, side: hit.side, action: 'reduce', triggerKind: profitKind, triggerPx: round(target), reduceFrac: 0.6 },
      { seq: 4, coin: hit.coin, side: hit.side, action: 'stop_move', triggerKind: profitKind, triggerPx: round(target), triggerMeta: { moveTo: 'trail', trailDistancePx: round(trailDistancePx) } },
    ],
  };
}

/** The Discord nudge for a fresh reversion draft. PURE (caller sends it). Quotes the SAME
 *  entry + stop the rung uses (via reversionEntry) so the alert never desyncs from the plan. */
export function reversionAlertMessage(hit: ReversionAlertHit, ladderId: string, cockpitBaseUrl?: string): string {
  // Clickable deep-link straight to the ladders tab so the operator can review + arm in one
  // tap. baseUrl has no trailing slash (env is validated); omitted only if unconfigured.
  const link = cockpitBaseUrl ? `\n👉 ${cockpitBaseUrl.replace(/\/$/, '')}/cockpit?tab=ladders` : '';
  const { entryPx, stopPx } = reversionEntry(hit);
  const restVerb = hit.side === 'short' ? 'an offer' : 'a bid';
  const fillOn = hit.side === 'short' ? 'further strength' : 'further weakness';
  return (
    `🔁 **Reversion fade candidate — ${hit.coin} ${hit.side.toUpperCase()}** (|z|=${Math.abs(hit.z).toFixed(1)}, ` +
    `regime ${hit.regime}/${Math.round(hit.regimeConf * 100)}%)\n` +
    `Auto-drafted a LIVE low-qty ladder \`${ladderId.slice(0, 8)}\` — rest ${restVerb} at ${entryPx.toFixed(4)} ` +
    `(fills on ${fillOn}), target the mean ${hit.target.toFixed(4)}, stop ${stopPx.toFixed(4)}. Reversion is the ` +
    `forward-testing edge (unproven) — **review + arm in the cockpit** if you like it (12h expiry; nothing fires ` +
    `until you arm).${link}`
  );
}
