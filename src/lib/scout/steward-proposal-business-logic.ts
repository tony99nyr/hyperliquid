/**
 * Steward proposal counterfactuals — PURE. "If we had executed this proposal,
 * would it have helped?" answered deterministically, so overnight unactioned
 * advice still builds a track record (the operator sleeps; the ledger doesn't).
 *
 * Sign convention: helpedUsd > 0 ⇒ acting on the proposal would have BEATEN
 * what actually happened; < 0 ⇒ the proposal would have hurt. Scored per the
 * position size frozen at proposal time.
 *
 * v1 scores two kinds exactly:
 *  - 'exit' / 'bank': counterfactual exit at the proposal-time mark vs the
 *    actual reference (the mark when the position went flat, or at the 24h
 *    horizon). Fraction is irrelevant to the verdict's sign — we score the
 *    full frozen size for magnitude consistency.
 *  - 'stop-tighten': replay the candles after the proposal; if the tightened
 *    stop would have been touched, the counterfactual exit is that stop, else
 *    the proposal changed nothing (cf = actual ⇒ helped = 0).
 * 'disarm' / 'widen-target' / 'info' resolve UNSCORABLE in v1 — recorded,
 * never guessed at.
 */

export interface ProposalRow {
  proposalKind: 'exit' | 'bank' | 'stop-tighten' | 'disarm' | 'widen-target' | 'info';
  side: 'long' | 'short' | null;
  positionSz: number | null;
  markPx: number | null;
  paramPx: number | null;
}

export interface CandleHL {
  highPx: number;
  lowPx: number;
}

export interface CounterfactualResult {
  scorable: boolean;
  cfExitPx: number | null;
  helpedUsd: number | null;
  note: string;
}

export function resolveProposalCounterfactual(
  p: ProposalRow,
  /** Completed candles from proposal time → resolution time (for stop replay). */
  candlesAfter: ReadonlyArray<CandleHL>,
  /** The actual reference price: mark when the position went flat, or at horizon. */
  actualRefPx: number,
): CounterfactualResult {
  if (!Number.isFinite(actualRefPx) || actualRefPx <= 0) {
    return { scorable: false, cfExitPx: null, helpedUsd: null, note: 'no actual reference price' };
  }
  const dir = p.side === 'long' ? 1 : p.side === 'short' ? -1 : 0;
  const sz = p.positionSz ?? 0;
  if (dir === 0 || !(sz > 0)) {
    return { scorable: false, cfExitPx: null, helpedUsd: null, note: 'no live position was referenced' };
  }

  if (p.proposalKind === 'exit' || p.proposalKind === 'bank') {
    if (p.markPx == null || !(p.markPx > 0)) {
      return { scorable: false, cfExitPx: null, helpedUsd: null, note: 'no mark frozen at proposal' };
    }
    const helpedUsd = dir * (p.markPx - actualRefPx) * sz;
    return {
      scorable: true,
      cfExitPx: p.markPx,
      helpedUsd,
      note: `exit@proposal ${p.markPx} vs actual ${actualRefPx}: ${helpedUsd >= 0 ? 'HELPED' : 'HURT'} $${Math.abs(helpedUsd).toFixed(2)}`,
    };
  }

  if (p.proposalKind === 'stop-tighten') {
    if (p.paramPx == null || !(p.paramPx > 0)) {
      return { scorable: false, cfExitPx: null, helpedUsd: null, note: 'stop-tighten without a concrete paramPx' };
    }
    // Would the tightened stop have been touched? (long: a low at/under it;
    // short: a high at/over it.)
    const touched = candlesAfter.some((c) => (dir === 1 ? c.lowPx <= p.paramPx! : c.highPx >= p.paramPx!));
    const cfExitPx = touched ? p.paramPx : actualRefPx;
    const helpedUsd = dir * (cfExitPx - actualRefPx) * sz;
    return {
      scorable: true,
      cfExitPx,
      helpedUsd,
      note: touched
        ? `tightened stop ${p.paramPx} would have filled vs actual ${actualRefPx}: ${helpedUsd >= 0 ? 'HELPED' : 'HURT'} $${Math.abs(helpedUsd).toFixed(2)}`
        : 'tightened stop never touched — no effect ($0)',
    };
  }

  return { scorable: false, cfExitPx: null, helpedUsd: null, note: `kind '${p.proposalKind}' is not scorable in v1` };
}

/** Aggregate the resolved ledger into the headline the operator reads. */
export function stewardScore(rows: ReadonlyArray<{ status: string; helpedUsd: number | null }>): {
  resolved: number;
  scorable: number;
  helpedCount: number;
  hurtCount: number;
  netHelpedUsd: number;
} {
  let scorable = 0;
  let helpedCount = 0;
  let hurtCount = 0;
  let netHelpedUsd = 0;
  let resolved = 0;
  for (const r of rows) {
    if (r.status !== 'resolved' && r.status !== 'unscorable') continue;
    resolved++;
    if (r.status !== 'resolved' || r.helpedUsd == null) continue;
    scorable++;
    netHelpedUsd += r.helpedUsd;
    if (r.helpedUsd > 0) helpedCount++;
    else if (r.helpedUsd < 0) hurtCount++;
  }
  return { resolved, scorable, helpedCount, hurtCount, netHelpedUsd };
}
