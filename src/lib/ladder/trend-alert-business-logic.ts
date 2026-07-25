/**
 * trend-alert — PURE. Turns "the iamrossi 8h system just turned bullish+confident
 * on a coin it is holding" into a LOW-QTY LIVE pyramiding ladder plan: small core
 * on confirmation, ≤ 2 decreasing adds into strength (the handoff's hard cap — the
 * engine's profit-coverage gate makes them anti-martingale), ATR-derived structural
 * stop, breakeven + trail, scale-outs. The cron service creates it as a DRAFT and
 * pings Discord; the operator still ARMS it (the human gate — we never auto-arm).
 *
 * This is the replacement for iamrossi's retired Base leverage lane (2–3% per
 * round-trip friction → HL perp fees ~2.5–4.5 bps/fill). LONG-ONLY by design:
 * the signal system is long-or-cash and never shorts. Kept pure so the plan is
 * deterministic + fixture-tested.
 */

import type { CreateLadderInput } from './ladder-service';

/** Title prefix — the dedupe key AND the ledger's setup-type tag. Keep stable. */
export const TREND_TITLE_PREFIX = 'trend-follow';

/** Everything the plan needs, gathered by the service. */
export interface TrendAlertContext {
  coin: string;
  mark: number;
  /** ATR(14) on 8h candles / mark — the vol input the stop is derived from. */
  atrFrac: number;
  regime: string;
  regimeConfidence: number;
}

export interface TrendPlanOpts {
  /** TOTAL campaign risk-at-stop across all entry rungs. Default 10 (probe size —
   *  ~1% of the ~$963 account; SIZE-UP only via the expectancy ledger's verdict). */
  campaignRiskUsd?: number;
  leverage?: number; // default 2 (isolated; slipped 15% stop still clears the ~49.6% liq line)
  expiryHours?: number; // default 120 (5d) — the flip guard is the real exit, expiry the backstop
  now: number;
}

/** Stop = 2×ATR(8h), bounded to [5%, 15%] — structural, never a tight round %. */
const stopFracFrom = (atrFrac: number): number => {
  const raw = Number.isFinite(atrFrac) && atrFrac > 0 ? 2 * atrFrac : 0.08;
  return Math.min(0.15, Math.max(0.05, raw));
};

const round = (x: number): number => Number(x.toFixed(6));

/**
 * Build the LIVE draft ladder for a fresh 8h bullish signal. Core enters on a
 * momentum-confirmed push through +0.3%; two decreasing adds at +2.5% / +5%
 * pyramid only out of profit (engine add-gate); breakeven at the first add level,
 * 40% banked at +6% where the trail takes over, 40% of the rest at +10%. PURE.
 */
export function buildTrendLadderPlan(ctx: TrendAlertContext, opts: TrendPlanOpts): CreateLadderInput {
  const campaignRiskUsd = opts.campaignRiskUsd ?? 10;
  const leverage = opts.leverage ?? 2;
  const expiryHours = opts.expiryHours ?? 120;
  const stopFrac = stopFracFrom(ctx.atrFrac);
  const mark = ctx.mark;
  const coin = ctx.coin.toUpperCase();

  // Decreasing-size split (core > add1 > add2), Σ = the campaign budget.
  const coreRisk = round(campaignRiskUsd * 0.5);
  const add1Risk = round(campaignRiskUsd * 0.3);
  const add2Risk = round(campaignRiskUsd * 0.2);

  // Slipped no-netting worst case: each stop can slip 10% OF PRICE, so the loss
  // multiplier is (1 + 0.10/stopFrac). Cap must clear it or the arm is refused.
  const slippedLoss = campaignRiskUsd * (1 + 0.1 / stopFrac);
  const totalNotional = campaignRiskUsd / stopFrac;

  const confPct = Math.round(ctx.regimeConfidence * 100);

  return {
    title: `${coin} ${TREND_TITLE_PREFIX} long — 8h bullish ${confPct}% (auto-draft · review+arm)`,
    thesis:
      `AUTO-DRAFTED from the iamrossi 8h trend stance: regime ${ctx.regime}/${confPct}% and the system is ` +
      `HOLDING ${coin} — this ladder is the retired-leverage-lane replacement (amplify an expressed signal, ` +
      `never front-run one). Pyramid into strength: momentum-confirmed core, ≤2 decreasing adds gated on ` +
      `profit coverage, stop 2×ATR(8h) ≈ ${(stopFrac * 100).toFixed(1)}% (structural), breakeven at the first ` +
      `add level, trail + scale-outs into extension. PROBE SIZE (~$${campaignRiskUsd} campaign risk) until the ` +
      `expectancy ledger earns a SIZE-UP. The regime-flip guard auto-disarms pending rungs if the 8h stance ` +
      `leaves bullish; the ${expiryHours}h expiry is the backstop. LIVE low-qty draft; the operator ARMS it.`,
    author: 'operator',
    mode: 'live',
    maxTotalLossUsd: Math.max(10, Math.ceil(slippedLoss * 1.15)), // +15% headroom for the funding fold-in at arm
    maxTotalNotionalUsd: Math.ceil(totalNotional * 1.3),
    expiresAtMs: opts.now + expiryHours * 60 * 60 * 1000,
    rungs: [
      {
        seq: 1, coin, side: 'long', action: 'open', triggerKind: 'price_above', triggerPx: round(mark * 1.003),
        riskUsd: coreRisk, stopFrac, leverage, triggerMeta: { momentumConfirm: true, momentumSustain: 2, momentumMaxFlips: 0 },
      },
      {
        seq: 2, coin, side: 'long', action: 'add', triggerKind: 'price_above', triggerPx: round(mark * 1.025),
        riskUsd: add1Risk, stopFrac, leverage,
      },
      { seq: 3, coin, side: 'long', action: 'stop_move', triggerKind: 'price_above', triggerPx: round(mark * 1.025), triggerMeta: { moveTo: 'breakeven' } },
      {
        seq: 4, coin, side: 'long', action: 'add', triggerKind: 'price_above', triggerPx: round(mark * 1.05),
        riskUsd: add2Risk, stopFrac, leverage,
      },
      { seq: 5, coin, side: 'long', action: 'reduce', triggerKind: 'price_above', triggerPx: round(mark * 1.06), reduceFrac: 0.4 },
      {
        seq: 6, coin, side: 'long', action: 'stop_move', triggerKind: 'price_above', triggerPx: round(mark * 1.06),
        triggerMeta: { moveTo: 'trail', trailDistancePx: round(Math.max(mark * 1.5 * (Number.isFinite(ctx.atrFrac) && ctx.atrFrac > 0 ? ctx.atrFrac : 0.04), 1e-6)) },
      },
      { seq: 7, coin, side: 'long', action: 'reduce', triggerKind: 'price_above', triggerPx: round(mark * 1.1), reduceFrac: 0.4 },
    ],
  };
}

/** The Discord nudge for a fresh trend draft. PURE (caller sends it). */
export function trendAlertMessage(ctx: TrendAlertContext, ladderId: string): string {
  const confPct = Math.round(ctx.regimeConfidence * 100);
  return (
    `📈 **Trend-follow candidate — ${ctx.coin.toUpperCase()} LONG** (iamrossi 8h: ${ctx.regime} ${confPct}%, holding)\n` +
    `Auto-drafted a LIVE low-qty pyramiding ladder \`${ladderId.slice(0, 8)}\` off mark ${ctx.mark.toFixed(4)} — ` +
    `the retired-leverage-lane replacement, probe size. **Review + arm in the cockpit** if you like it ` +
    `(the regime-flip guard covers the exit side; nothing fires until you arm).`
  );
}
