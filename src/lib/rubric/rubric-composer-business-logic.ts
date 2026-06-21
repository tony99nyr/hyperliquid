/**
 * PURE rubric composer — the keystone. For one asset, computes BOTH sides:
 *   score = regimeMultiplier × additiveEnvelope(leaders, carry, micro)   [0–100]
 * with GATES that zero a side, then resolves the asset to GO / WATCH / NO-EDGE.
 * NO-TRADE is first-class. Deterministic: same RubricInputs → identical result
 * (asOf is injected; no Date.now()/random). Fixture-tested.
 */

import type { RubricConfig } from './rubric-config-types';
import type { Badge, NoTradeReason, RubricInputs, RubricResult, Side, SideScore } from './rubric-types';
import {
  regimeMultiplier,
  scoreCarryPillar,
  scoreLeadersPillar,
  scoreMicroPillar,
  scoreRegimePillar,
} from './rubric-scorers-business-logic';
import { deriveLevels, evaluateGates, firstFailingGate } from './rubric-gates-business-logic';

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

function computeSide(inp: RubricInputs, side: Side, cfg: RubricConfig): SideScore {
  const levels = deriveLevels(inp.markPx, inp.atr, side, cfg);
  const gates = evaluateGates(inp, levels, side, cfg);
  const killedBy = firstFailingGate(gates);

  const pillars = {
    regime: scoreRegimePillar(inp.regimeByTf, side),
    leaders: scoreLeadersPillar(inp.consensus, side, cfg),
    carry: scoreCarryPillar(inp.ctx, side, cfg),
    micro: scoreMicroPillar(inp.book, side, cfg),
  };
  const mult = regimeMultiplier(inp.regimeByTf, side, cfg);

  let opportunity = 0;
  if (!killedBy) {
    const w = cfg.weights;
    const wsum = w.leaders + w.carry + w.micro || 1;
    // Additive envelope (0–100) of the NON-regime pillars, then regime MULTIPLIES it.
    const envelope = (w.leaders * pillars.leaders + w.carry * pillars.carry + w.micro * pillars.micro) / wsum;
    opportunity = Math.round(mult * envelope);
  }

  return { side, opportunity, pillars, regimeMultiplier: mult, gates, killedBy, levels };
}

export function computeRubric(inp: RubricInputs, cfg: RubricConfig): RubricResult {
  const long = computeSide(inp, 'long', cfg);
  const short = computeSide(inp, 'short', cfg);

  const max = Math.max(long.opportunity, short.opportunity);
  const margin = Math.abs(long.opportunity - short.opportunity);
  const winner = long.opportunity >= short.opportunity ? long : short;
  // vol-contraction is an asset-level gate (ATR/BB percentile, side-independent) —
  // read it once rather than off whichever side happens to be the winner.
  const volContraction = long.gates.volContraction;
  // margin-too-thin only means something when BOTH sides are live: comparing a real
  // score against a gated side's forced 0 is not a genuine two-sided contest.
  const oneSideGated = Boolean(long.killedBy) !== Boolean(short.killedBy);

  let badge: Badge;
  let chosenSide: Side | 'none';
  let noTradeReason: NoTradeReason = null;

  if (long.killedBy && short.killedBy) {
    badge = 'NO-EDGE';
    chosenSide = 'none';
    noTradeReason = volContraction ? 'vol-contraction' : 'both-gated';
  } else if (winner.killedBy && volContraction) {
    // The would-be winner is in a vol-contraction chop → stand down (chop-bleed guard).
    badge = 'NO-EDGE';
    chosenSide = 'none';
    noTradeReason = 'vol-contraction';
  } else if (max < cfg.thresholds.bar) {
    badge = 'NO-EDGE';
    chosenSide = 'none';
    noTradeReason = 'below-bar';
  } else if (!oneSideGated && margin < cfg.thresholds.margin) {
    badge = 'NO-EDGE';
    chosenSide = 'none';
    noTradeReason = 'margin-too-thin';
  } else {
    badge = max >= cfg.thresholds.go ? 'GO' : 'WATCH';
    chosenSide = winner.side;
  }

  // Confidence: how far above the bar + how decisive vs the other side. Honest,
  // drives the UI dots; NOT a probability.
  const aboveBar = clamp((max - cfg.thresholds.bar) / Math.max(1, 100 - cfg.thresholds.bar), 0, 1);
  const decisiveness = clamp(margin / Math.max(1, 2 * cfg.thresholds.margin), 0, 1);
  const confidence = chosenSide === 'none' ? clamp(0.3 * aboveBar, 0, 0.4) : clamp(0.4 * aboveBar + 0.6 * decisiveness, 0, 1);

  const bandWidth = Math.round((1 - confidence) * 12);
  const scoreBandLow = clamp(max - bandWidth, 0, 100);
  const scoreBandHigh = clamp(max + bandWidth, 0, 100);

  return { coin: inp.coin, asOf: inp.asOf, long, short, badge, chosenSide, noTradeReason, confidence, scoreBandLow, scoreBandHigh };
}
