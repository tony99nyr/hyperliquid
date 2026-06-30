/**
 * review-ladder — PURE "pro-desk" critical scorecard for a ladder (fixture-tested).
 *
 * Encodes the adversarial review panel as deterministic 0/10 pillars across two axes —
 * RISK (is it safe / well-managed?) and UPSIDE (is the payoff worth it?) — each pillar
 * mapped to the desk reviewer "lens" it represents. No I/O: the caller resolves the
 * ladder + supplies live context (mids, funding, equity). ADVISORY ONLY — scoring never
 * arms or trades; it informs the operator who reviews, builds, and arms.
 *
 * The deterministic pillars are computed here from the engine's own consent math
 * (computeLadderRisk + validateLadderForArm — slip-aware, no-netting). The two inherently
 * JUDGMENT pillars (thesis/signal quality, entry timing) accept optional 0-10 inputs the
 * caller (Claude, after analyze-market / analyze-traders) supplies; absent, they score a
 * neutral 5 and flag that a human/Claude read is owed.
 */

import type { LadderWithRungs } from '@/lib/ladder/ladder-types';
import { STOP_SLIPPAGE_TOL, type LadderRiskRead } from '@/lib/ladder/ladder-risk-business-logic';
import { resolveArmRung, validateLadderForArm, type ArmRung } from '@/lib/ladder/ladder-arm-business-logic';
import { resolveCoinMaxLeverage, MMR } from '@/lib/trading/leverage-business-logic';

/** A single scored category. `score` is 0-10 (higher = better: safer for risk pillars,
 *  more attractive for upside pillars). `lens` names the desk reviewer it represents. */
export interface PillarScore {
  key: string;
  label: string;
  lens: string;
  score: number;
  note: string;
}

export interface LadderReviewScorecard {
  ladderId: string;
  title: string;
  status: string;
  mode: string;
  riskPillars: PillarScore[];
  upsidePillars: PillarScore[];
  /** Mean of the risk pillars (0-10). */
  riskScore: number;
  /** Mean of the upside pillars (0-10). */
  upsideScore: number;
  /** Hard blockers (an armed/arming ladder can't safely proceed until cleared). */
  blockers: string[];
  verdict: string;
  /** Echoed engine numbers for the caller to print alongside the pillars. */
  worstCaseLossUsd: number;
  worstCaseLossWithFundingUsd: number;
  totalNotionalUsd: number;
  pctOfEquity: number | null;
}

export interface LadderReviewContext {
  /** Current mark per coin (uppercased keys). */
  midByCoin: Record<string, number | null>;
  /** Current hourly funding per coin (decimal; + = longs pay). */
  fundingByCoin?: Record<string, number | null>;
  /** Account equity (USD) for %-of-account sizing. Null ⇒ that pillar scores neutral. */
  accountEquityUsd?: number | null;
  /** Sum of worst-case loss across ALL other live/armed ladders (book heat). */
  otherLaddersWorstCaseUsd?: number | null;
  /** Optional judgment inputs (0-10) the caller supplies after a market/trader read. */
  signalScore?: number | null;
  timingScore?: number | null;
  now: number;
}

const clamp = (n: number, lo = 0, hi = 10): number => Math.max(lo, Math.min(hi, n));
const round1 = (n: number): number => Math.round(n * 10) / 10;
const mean = (xs: number[]): number => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
/** Map a value linearly from [good, bad] → [10, 0], clamped. */
const lerp10 = (value: number, good: number, bad: number): number => clamp(((bad - value) / (bad - good)) * 10);

const isOpenAdd = (a: string): boolean => a === 'open' || a === 'add';

function stopFracOf(r: ArmRung): number | null {
  if (r.entryPx == null || !(r.entryPx > 0) || r.stopPx == null || !(r.stopPx > 0)) return null;
  return Math.abs(r.entryPx - r.stopPx) / r.entryPx;
}

/* ----------------------------- RISK pillars ----------------------------- */

/** Liquidation safety (Derivatives-execution lens): the SLIPPED stop fill must clear the
 *  isolated liq line with margin. clearance = (1/L − MMR) / ((1+slip)·stopFrac). */
function liqSafety(open: ArmRung[]): PillarScore {
  const clearances: number[] = [];
  for (const r of open) {
    const sf = stopFracOf(r);
    const L = r.leverage ?? null;
    if (sf == null || L == null || !(L > 0)) continue;
    const liqDist = 1 / L - MMR;
    const slipped = (1 + STOP_SLIPPAGE_TOL) * sf;
    if (slipped > 0) clearances.push(liqDist / slipped);
  }
  if (clearances.length === 0) return { key: 'liq', label: 'Liquidation safety', lens: 'Derivatives execution', score: 10, note: 'No new exposure rungs — no liq risk to add.' };
  const worst = Math.min(...clearances);
  // ≥2× clearance → 10; ≤1× (stop at/through liq) → 0.
  const score = lerp10(worst, 2, 1);
  return { key: 'liq', label: 'Liquidation safety', lens: 'Derivatives execution', score, note: `Tightest slipped-stop clears liq by ${worst.toFixed(2)}× (want ≥2×; <1× = liquidated before the stop fills).` };
}

/** Loss cap & sizing (Risk-CRO lens): the slip-aware no-netting worst case as a % of
 *  equity, and whether it clears the declared cap. */
function lossSizing(risk: LadderRiskRead, equity: number | null, capUsd: number | null): { pillar: PillarScore; blocker: string | null } {
  const wc = risk.worstCaseLossWithFundingUsd;
  let blocker: string | null = null;
  if (capUsd != null && wc > capUsd + 1e-9) blocker = `Worst case $${wc.toFixed(0)} exceeds the loss cap $${capUsd.toFixed(0)} (won't arm).`;
  if (equity == null || !(equity > 0)) {
    return { pillar: { key: 'loss', label: 'Loss cap & sizing', lens: 'Risk (CRO)', score: 5, note: 'No account equity supplied — supply it for a %-of-account read.' }, blocker };
  }
  const pct = (wc / equity) * 100;
  // ≤1% → 10; ≥5% → 0.
  let score = lerp10(pct, 1, 5);
  if (blocker) score = Math.min(score, 2);
  return { pillar: { key: 'loss', label: 'Loss cap & sizing', lens: 'Risk (CRO)', score, note: `Slip-aware worst case $${wc.toFixed(0)} = ${pct.toFixed(1)}% of equity${blocker ? ' — EXCEEDS the cap' : ''}.` }, blocker };
}

/** Stop integrity (Tail-risk lens): every exposure rung stopped on the loss side, and not
 *  pathologically tight (wick-bait). */
function stopIntegrity(open: ArmRung[], warnings: string[]): { pillar: PillarScore; blocker: string | null } {
  const naked = open.some((r) => r.stopPx == null || !(r.stopPx > 0));
  const lossSideWarn = warnings.some((w) => /not on the loss side|must carry a protective stop|UNBOUNDED/i.test(w));
  if (naked || lossSideWarn) {
    return { pillar: { key: 'stop', label: 'Stop integrity', lens: 'Crypto tail-risk', score: 0, note: 'An open/add rung is unstopped or mis-sided — worst case is unbounded.' }, blocker: 'A protective stop is missing or on the wrong side.' };
  }
  const fracs = open.map(stopFracOf).filter((x): x is number => x != null);
  if (fracs.length === 0) return { pillar: { key: 'stop', label: 'Stop integrity', lens: 'Crypto tail-risk', score: 8, note: 'No new-exposure stops to assess.' }, blocker: null };
  const tightest = Math.min(...fracs);
  // Very tight stops sit inside crypto noise → wick-bait. Heuristic (no ATR here).
  const score = tightest < 0.02 ? 3 : tightest < 0.04 ? 6 : tightest < 0.07 ? 8 : 10;
  return { pillar: { key: 'stop', label: 'Stop integrity', lens: 'Crypto tail-risk', score, note: `Tightest stop ${(tightest * 100).toFixed(1)}% from entry${tightest < 0.04 ? ' — tight for a high-vol alt (wick-out risk)' : ''}.` }, blocker: null };
}

/** Pyramiding discipline (Process lens): decreasing add size + aggregate-stop tightening,
 *  no martingale. Read off the arm warnings. */
function pyramiding(rungs: LadderWithRungs['rungs'], warnings: string[]): { pillar: PillarScore; blocker: string | null } {
  const pyramidWarn = warnings.find((w) => /must DECREASE|only TIGHTEN|averaging/i.test(w));
  const hasAdd = rungs.some((r) => r.action === 'add');
  if (pyramidWarn) {
    return { pillar: { key: 'pyr', label: 'Pyramiding discipline', lens: 'Process & psychology', score: 2, note: pyramidWarn }, blocker: pyramidWarn };
  }
  return { pillar: { key: 'pyr', label: 'Pyramiding discipline', lens: 'Process & psychology', score: hasAdd ? 10 : 8, note: hasAdd ? 'Adds decrease in size and the stop only tightens (engine-checked).' : 'Single-entry (no pyramid) — fine, just not scaling into strength.' }, blocker: null };
}

/** Funding / carry (Derivatives lens): estimated funding cost as a share of the stop risk. */
function fundingCarry(risk: LadderRiskRead): PillarScore {
  const cost = Math.max(0, risk.expectedFundingUsd);
  const base = risk.aggregateWorstCaseLossUsd;
  if (!(base > 0)) return { key: 'fund', label: 'Funding / carry', lens: 'Derivatives execution', score: 10, note: 'No stop-bearing exposure to carry.' };
  const pct = (cost / base) * 100;
  // ≤5% of stop risk → 10; ≥50% → 0.
  const score = lerp10(pct, 5, 50);
  return { key: 'fund', label: 'Funding / carry', lens: 'Derivatives execution', score, note: cost > 0 ? `Est. funding $${cost.toFixed(2)} = ${pct.toFixed(0)}% of stop risk over the window.` : 'Negligible / favorable funding.' };
}

/** Operational guards (Ops lens): expiry present + sane, leverage in band, caps set,
 *  book heat within budget. */
function operational(ladder: LadderWithRungs, risk: LadderRiskRead, warnings: string[], ctx: LadderReviewContext): { pillar: PillarScore; blocker: string | null } {
  let score = 10;
  const notes: string[] = [];
  let blocker: string | null = null;
  const expMs = ladder.expiresAt ? Date.parse(ladder.expiresAt) : NaN;
  if (!Number.isFinite(expMs)) { score -= 4; notes.push('no expiry'); }
  else {
    const days = (expMs - ctx.now) / 86_400_000;
    if (days <= 0) { score -= 5; notes.push('expired'); blocker = 'Ladder is expired.'; }
    else if (days > 10) { score -= 2; notes.push(`long expiry (${days.toFixed(0)}d)`); }
  }
  if (warnings.some((w) => /exceeds .* max|leverage/i.test(w))) { score -= 4; notes.push('leverage out of band'); }
  if (ladder.maxTotalNotionalUsd == null || ladder.maxTotalLossUsd == null) { score -= 3; notes.push('caps missing'); }
  // Book heat: this ladder + others vs equity.
  if (ctx.accountEquityUsd && ctx.accountEquityUsd > 0 && ctx.otherLaddersWorstCaseUsd != null) {
    const heatPct = ((risk.worstCaseLossWithFundingUsd + ctx.otherLaddersWorstCaseUsd) / ctx.accountEquityUsd) * 100;
    if (heatPct > 6) { score -= 3; notes.push(`book heat ${heatPct.toFixed(1)}% > 6%`); }
  }
  return { pillar: { key: 'ops', label: 'Operational guards', lens: 'Ops / execution', score: clamp(score), note: notes.length ? notes.join('; ') : 'Expiry, caps, leverage band all sane.' }, blocker };
}

/* ----------------------------- UPSIDE pillars ----------------------------- */

/** Reward:risk (Quant lens): blended R-multiple from the core entry/stop to the first
 *  scale-out target. */
function rewardRisk(rungs: LadderWithRungs['rungs'], armRungs: ArmRung[]): PillarScore {
  const core = armRungs.find((r) => r.action === 'open') ?? armRungs.find((r) => isOpenAdd(r.action));
  const target = rungs
    .filter((r) => (r.action === 'reduce' || r.action === 'close') && r.triggerPx != null && r.triggerPx > 0)
    .map((r) => r.triggerPx as number)
    .sort((a, b) => a - b)[0]; // nearest target
  if (!core || core.entryPx == null || core.stopPx == null || target == null) {
    return { key: 'rr', label: 'Reward : risk', lens: 'Quant volatility', score: 3, note: 'No defined scale-out target to measure R against.' };
  }
  const reward = core.side === 'long' ? target - core.entryPx : core.entryPx - target;
  const risk = Math.abs(core.entryPx - core.stopPx);
  if (!(risk > 0) || !(reward > 0)) return { key: 'rr', label: 'Reward : risk', lens: 'Quant volatility', score: 2, note: 'Target is not beyond entry on the trade side.' };
  const R = reward / risk;
  // ≥3R → 10; ≤1R → 2.
  const score = clamp(((R - 1) / (3 - 1)) * 8 + 2);
  return { key: 'rr', label: 'Reward : risk', lens: 'Quant volatility', score, note: `~${R.toFixed(1)}R to the first target (${target}).` };
}

/** Scale-out plan (Process lens): banking discipline — reduce/close rungs present, ideally
 *  path-independent (reduceFrac). */
function scaleOutPlan(rungs: LadderWithRungs['rungs']): PillarScore {
  const reducers = rungs.filter((r) => r.action === 'reduce' || r.action === 'close');
  const fracBased = reducers.some((r) => r.reduceFrac != null && r.reduceFrac > 0);
  const score = reducers.length === 0 ? 3 : reducers.length === 1 ? 7 : 10;
  return { key: 'scale', label: 'Scale-out plan', lens: 'Process & psychology', score, note: reducers.length === 0 ? 'No scale-out rungs — all-or-nothing exit.' : `${reducers.length} scale-out rung(s)${fracBased ? ', path-independent (reduceFrac)' : ' (absolute size)'}.` };
}

/** Convexity / pyramiding (Quant lens): does it scale into strength (an add rung)? */
function convexity(rungs: LadderWithRungs['rungs']): PillarScore {
  const hasAdd = rungs.some((r) => r.action === 'add');
  return { key: 'convex', label: 'Convexity (pyramid)', lens: 'Quant volatility', score: hasAdd ? 9 : 5, note: hasAdd ? 'Pyramids into strength (adds on confirmation) — right-tail capture.' : 'Single-shot — bounded upside, no scale-in.' };
}

/** Thesis & timing (judgment lens): supplied by the caller after analyze-market /
 *  analyze-traders; neutral 5 + an owed-read flag when absent. */
function thesisTiming(ctx: LadderReviewContext): PillarScore {
  const parts: number[] = [];
  if (ctx.signalScore != null) parts.push(clamp(ctx.signalScore));
  if (ctx.timingScore != null) parts.push(clamp(ctx.timingScore));
  if (parts.length === 0) return { key: 'thesis', label: 'Thesis & timing', lens: 'Judgment (analyze-market / traders)', score: 5, note: 'NOT scored — run analyze-market / analyze-traders and pass signal/timing (0-10).' };
  return { key: 'thesis', label: 'Thesis & timing', lens: 'Judgment (analyze-market / traders)', score: mean(parts), note: `Signal ${ctx.signalScore ?? '—'}/10, timing ${ctx.timingScore ?? '—'}/10 (caller-supplied).` };
}

/* ----------------------------- compose ----------------------------- */

export function reviewLadder(ladder: LadderWithRungs, ctx: LadderReviewContext): LadderReviewScorecard {
  const armRungs = ladder.rungs.map(resolveArmRung);
  const validation = validateLadderForArm({
    title: ladder.title,
    thesis: ladder.thesis,
    expiresAtMs: ladder.expiresAt ? Date.parse(ladder.expiresAt) : null,
    caps: { maxTotalNotionalUsd: ladder.maxTotalNotionalUsd, maxTotalLossUsd: ladder.maxTotalLossUsd },
    rungs: armRungs,
    now: ctx.now,
    coinMaxLeverage: (c) => resolveCoinMaxLeverage(c, null),
    fundingRateByCoin: ctx.fundingByCoin,
  });
  const risk = validation.risk;
  const warnings = validation.warnings;
  const open = armRungs.filter((r) => isOpenAdd(r.action));

  const blockers: string[] = [];
  const liq = liqSafety(open);
  const loss = lossSizing(risk, ctx.accountEquityUsd ?? null, ladder.maxTotalLossUsd); if (loss.blocker) blockers.push(loss.blocker);
  const stop = stopIntegrity(open, warnings); if (stop.blocker) blockers.push(stop.blocker);
  const pyr = pyramiding(ladder.rungs, warnings); if (pyr.blocker) blockers.push(pyr.blocker);
  const fund = fundingCarry(risk);
  const ops = operational(ladder, risk, warnings, ctx); if (ops.blocker) blockers.push(ops.blocker);

  const round = (p: PillarScore): PillarScore => ({ ...p, score: round1(p.score) });
  const riskPillars = [liq, loss.pillar, stop.pillar, pyr.pillar, fund, ops.pillar].map(round);
  const upsidePillars = [rewardRisk(ladder.rungs, armRungs), scaleOutPlan(ladder.rungs), convexity(ladder.rungs), thesisTiming(ctx)].map(round);

  const riskScore = mean(riskPillars.map((p) => p.score));
  const upsideScore = mean(upsidePillars.map((p) => p.score));
  const equity = ctx.accountEquityUsd && ctx.accountEquityUsd > 0 ? ctx.accountEquityUsd : null;

  let verdict: string;
  if (blockers.length > 0) verdict = `BLOCKED — ${blockers.length} hard issue(s) to clear before it can arm/hold.`;
  else if (riskScore >= 7 && upsideScore >= 6) verdict = 'STRONG — well-managed risk with a worthwhile payoff.';
  else if (riskScore >= 6) verdict = 'SOUND — risk is well-managed; confirm the upside/thesis is worth it.';
  else if (riskScore >= 4) verdict = 'CAUTION — fixable risk gaps; tighten before sizing up.';
  else verdict = 'RISKY — material risk gaps; reduce size or rework.';

  return {
    ladderId: ladder.id,
    title: ladder.title,
    status: ladder.status,
    mode: ladder.mode,
    riskPillars,
    upsidePillars,
    riskScore,
    upsideScore,
    blockers,
    verdict,
    worstCaseLossUsd: round1(risk.aggregateWorstCaseLossUsd),
    worstCaseLossWithFundingUsd: round1(risk.worstCaseLossWithFundingUsd),
    totalNotionalUsd: round1(risk.totalNotionalUsd),
    pctOfEquity: equity ? round1((risk.worstCaseLossWithFundingUsd / equity) * 100) : null,
  };
}
