/**
 * desk-review — PURE helpers. The desk-review skill gathers the whole book + market
 * read (I/O, in scripts/desk-review.ts) and this classifies each coin into a
 * short-term vs long-term trend read + an opportunity flag. Kept pure so the
 * classification is deterministic + fixture-tested; the SKILL does the human synthesis.
 */

import type { TimeframeRead, MarketTimeframe } from './analyze-market-business-logic';

export type TrendDir = 'bull' | 'bear' | 'neutral';

/** Confidence-weighted directional sign over a set of TF reads (−1..+1). */
function dirScore(reads: TimeframeRead[]): number {
  let num = 0;
  let den = 0;
  for (const r of reads) {
    if (!r.hasData) continue;
    const sign = r.regime === 'bullish' ? 1 : r.regime === 'bearish' ? -1 : 0;
    num += sign * r.confidence;
    den += 1;
  }
  return den === 0 ? 0 : num / den;
}

function label(score: number): TrendDir {
  if (score > 0.12) return 'bull';
  if (score < -0.12) return 'bear';
  return 'neutral';
}

export interface TrendSplit {
  /** 1d + 8h — the structural / longer-horizon trend. */
  longTerm: TrendDir;
  /** 1h + 15m — the near-term / timing trend. */
  shortTerm: TrendDir;
  /** Both non-neutral and pointing the SAME way. */
  aligned: boolean;
  /** Short-term turning against a still-intact long-term trend (a pullback/bounce). */
  counterTrendPullback: boolean;
  longScore: number;
  shortScore: number;
}

const LONG_TFS: MarketTimeframe[] = ['1d', '8h'];
const SHORT_TFS: MarketTimeframe[] = ['1h', '15m'];

/** Split a multi-TF read into long- vs short-term trend + their relationship. PURE. */
export function splitTrend(reads: TimeframeRead[]): TrendSplit {
  const byTf = new Map(reads.map((r) => [r.timeframe, r]));
  const pick = (tfs: MarketTimeframe[]) => tfs.map((t) => byTf.get(t)).filter((r): r is TimeframeRead => !!r);
  const longScore = dirScore(pick(LONG_TFS));
  const shortScore = dirScore(pick(SHORT_TFS));
  const longTerm = label(longScore);
  const shortTerm = label(shortScore);
  const aligned = longTerm !== 'neutral' && longTerm === shortTerm;
  // A pullback/bounce: LT has a direction, ST leans the OPPOSITE way.
  const counterTrendPullback =
    longTerm !== 'neutral' && shortTerm !== 'neutral' && longTerm !== shortTerm;
  return { longTerm, shortTerm, aligned, counterTrendPullback, longScore, shortScore };
}

export type OpportunityFlag = 'GO' | 'WATCH' | 'REVERSION' | 'NONE';

export interface OpportunityInput {
  /** Best rubric read for the coin (highest opportunity across sides), or null. */
  rubricBest: { side: 'long' | 'short'; opportunity: number; badge: string } | null;
  /** A live reversion-extreme fade candidate for the coin, or null. */
  reversion: { side: 'long' | 'short'; z: number } | null;
}

/**
 * Collapse the deterministic signals into ONE flag. Rubric GO wins; a reversion
 * candidate is its own flag (a distinct, backtested edge); a WATCH-badge rubric is a
 * watch; everything else is NONE. Advisory — the SKILL + operator decide to act. PURE.
 */
export function opportunityFlag(inp: OpportunityInput): OpportunityFlag {
  if (inp.rubricBest?.badge === 'GO') return 'GO';
  if (inp.reversion) return 'REVERSION';
  if (inp.rubricBest?.badge === 'WATCH') return 'WATCH';
  return 'NONE';
}

/** One-line trend descriptor, e.g. "LT bear · ST bull (bounce)". PURE. */
export function trendLine(s: TrendSplit): string {
  const rel = s.aligned ? 'aligned' : s.counterTrendPullback ? 'counter-trend' : 'mixed';
  return `LT ${s.longTerm} · ST ${s.shortTerm} (${rel})`;
}

/**
 * The conditional-entry SHAPE that fits a coin's structure — the "IF it hits X THEN
 * enter" pattern to arm proactively, instead of reactively chasing or watching a move
 * go by. This does NOT say "trade" — it names the resting-order shape a thesis would
 * take, so desk-review can point at where a conditional ladder belongs. The operator +
 * panel supply the conviction and the exact levels.
 */
export type ConditionalShape =
  | 'reversion-fade' // a statistical extreme → fade to mean (forward test KILLED 08-06 at −0.55R — surfaced as CONTEXT, never "proven")
  | 'breakdown-short' // rubric leans short → arm a short that fires on the confirmed level break
  | 'reclaim-long' // rubric leans long → arm a long that fires on the confirmed reclaim
  | 'bounce-short' // structural DOWNtrend → arm a short into a bounce (don't chase the grind)
  | 'dip-long' // structural UPtrend → arm a long into a dip
  | 'none';

export interface ConditionalSetupInput {
  trend: TrendSplit | null;
  rubricBest: { side: 'long' | 'short'; opportunity: number; badge: string } | null;
  reversion: { side: 'long' | 'short'; z: number } | null;
}

export interface ConditionalSetup {
  shape: ConditionalShape;
  /** Whether this shape is a backtested edge (reversion) or a discretionary scaffold. */
  proven: boolean;
  rationale: string;
}

/**
 * Pick the conditional-entry shape. Priority: a live dislocation (reversion CONTEXT)
 * first, then a rubric-directional break (arm AHEAD of the WATCH→GO confirmation — the
 * proactive play), then a trend-continuation entry-on-a-counter-move. PURE. Advisory
 * only — EVERY shape is discretionary scaffolding, not a signal: the reversion-fade
 * forward test was KILLED on 2026-08-06 (n=12, −0.55R — dislocations kept trending),
 * so it must never again be labeled "proven"; the losses clustered in exactly the
 * fade-against-an-aligned-trend setups this section used to invite.
 */
export function conditionalSetup(inp: ConditionalSetupInput): ConditionalSetup {
  if (inp.reversion) {
    return {
      shape: 'reversion-fade',
      proven: false,
      rationale:
        `|z|=${Math.abs(inp.reversion.z).toFixed(1)} extreme (CONTEXT ONLY — the fade lane was KILLED at −0.55R: ` +
        `dislocations kept trending; do not knife-catch without independent confirmation)`,
    };
  }
  const rb = inp.rubricBest;
  if (rb && (rb.badge === 'GO' || rb.badge === 'WATCH')) {
    const ahead = rb.badge === 'WATCH' ? 'arm AHEAD of confirmation — fires when WATCH→GO (the level breaks)' : 'edge cleared — arm the confirmation-triggered entry';
    return rb.side === 'short'
      ? { shape: 'breakdown-short', proven: false, rationale: `rubric short ${Math.round(rb.opportunity)} (${rb.badge}) → ${ahead}` }
      : { shape: 'reclaim-long', proven: false, rationale: `rubric long ${Math.round(rb.opportunity)} (${rb.badge}) → ${ahead}` };
  }
  if (inp.trend && inp.trend.longTerm !== 'neutral') {
    return inp.trend.longTerm === 'bear'
      ? { shape: 'bounce-short', proven: false, rationale: 'structural downtrend → arm a short into a bounce (better R:R than chasing the grind); momentum-confirm the roll-over' }
      : { shape: 'dip-long', proven: false, rationale: 'structural uptrend → arm a long into a dip; momentum-confirm the turn' };
  }
  return { shape: 'none', proven: false, rationale: 'no structural bias + no rubric edge — nothing to pre-position' };
}
