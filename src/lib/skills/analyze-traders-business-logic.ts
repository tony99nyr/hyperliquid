/**
 * analyze-traders — PURE grading + ranking logic (fixture-tested).
 *
 * Discovers/grades HL traders to potentially follow. The hard rule lives here:
 * the **INSUFFICIENT_HISTORY data-completeness gate**. A wallet whose fill
 * history is thin or page-capped CANNOT be graded a clean A — the 0x418aa6
 * lesson: a wallet looked like a clean A on thin data, then turned out to be a
 * $16M live martingale once the full history loaded. Grading on incomplete data
 * is the failure mode this module exists to prevent.
 *
 * No I/O, no clock, no env — the rated wallet, live state and fills all come in
 * as parameters. The thin script entrypoint (scripts/analyze-traders.ts) fetches
 * those and calls this. ADVISORY ONLY: nothing here (or in the script) executes
 * a trade.
 */

import type { RatedWallet } from '@/lib/hyperliquid/rated-wallets-service';
import type { HlClearinghouseState, HlFill } from '@/lib/hyperliquid/hyperliquid-info-service';
import { buildCopyMonitorAnalytics, type MonitorAlert } from '@/lib/hyperliquid/copy-monitor-analytics';

/** Letter grade a candidate can be assigned (best → worst). */
export type CandidateGrade = 'A' | 'B' | 'C' | 'D' | 'F';

/**
 * Data-completeness verdict. `INSUFFICIENT_HISTORY` is the gate: the wallet's
 * fill record is too thin / page-capped to grade confidently.
 */
export type DataCompleteness = 'COMPLETE' | 'INSUFFICIENT_HISTORY';

/** Thresholds the gate uses. Conservative on purpose — false A's are the danger. */
export const COMPLETENESS_THRESHOLDS = {
  /** Below this many cached fills we cannot trust the rating distribution. */
  minFills: 50,
  /**
   * HL's userFills endpoints page-cap around 2000 rows. A wallet returning at or
   * above this in the lookback is almost certainly truncated — we have NOT seen
   * its full (possibly martingale) tail, so treat it as incomplete.
   */
  pageCapFills: 2000,
} as const;

/** The graded candidate the user picks from. */
export interface TraderCandidate {
  address: string;
  short: string;
  displayName: string | null;
  /** Final grade AFTER the completeness gate is applied. */
  grade: CandidateGrade;
  /** Composite score 0–10 from the rating dataset (null when unrated). */
  composite: number | null;
  completeness: DataCompleteness;
  /** Why the completeness verdict was reached (human-readable). */
  completenessReason: string;
  /** Risk flags from the rating dataset (martingale, no-stops, …). */
  flags: string[];
  /** Live copy-risk alerts derived from the leader's current state + fills. */
  alerts: MonitorAlert[];
  /** Fills actually seen for this wallet (the gate input). */
  fillsSeen: number;
  /** Live account value (USD), for sizing context. */
  accountValueUsd: number;
  /** One-line rationale summarizing the verdict. */
  rationale: string;
}

/** Map the dataset's best philosophy letter grade to our scale (default F). */
function bestRatedGrade(wallet: RatedWallet): CandidateGrade {
  const order: CandidateGrade[] = ['A', 'B', 'C', 'D', 'F'];
  let best: CandidateGrade = 'F';
  for (const g of Object.values(wallet.grades)) {
    const letter = (g.grade ?? '').trim().charAt(0).toUpperCase() as CandidateGrade;
    if (order.includes(letter) && order.indexOf(letter) < order.indexOf(best)) {
      best = letter;
    }
  }
  return best;
}

/**
 * Assess data completeness from the fills actually seen. PURE.
 *
 * - Fewer than `minFills` cached fills ⇒ INSUFFICIENT_HISTORY (too little to
 *   trust the rating).
 * - At/above the page-cap ⇒ INSUFFICIENT_HISTORY (the history is truncated; the
 *   dangerous tail may be unseen — the 0x418aa6 lesson).
 */
export function assessDataCompleteness(fillsSeen: number): {
  completeness: DataCompleteness;
  reason: string;
} {
  if (fillsSeen < COMPLETENESS_THRESHOLDS.minFills) {
    return {
      completeness: 'INSUFFICIENT_HISTORY',
      reason: `Only ${fillsSeen} fills seen (< ${COMPLETENESS_THRESHOLDS.minFills}); too thin to grade confidently.`,
    };
  }
  if (fillsSeen >= COMPLETENESS_THRESHOLDS.pageCapFills) {
    return {
      completeness: 'INSUFFICIENT_HISTORY',
      reason: `${fillsSeen} fills hits the API page cap (~${COMPLETENESS_THRESHOLDS.pageCapFills}); history is truncated — the tail may be unseen.`,
    };
  }
  return { completeness: 'COMPLETE', reason: `${fillsSeen} fills — full enough to grade.` };
}

/**
 * THE GATE. Apply the completeness verdict to a provisional grade.
 *
 * An INSUFFICIENT_HISTORY wallet is CAPPED at 'B' and can NEVER be a clean A —
 * even if every rating philosophy gave it an A on the thin data. A 'DISQUALIFIED'
 * flag still forces 'F' regardless. This is the single most important rule in the
 * skill; the regression test pins it (a thin-history wallet never gets grade A).
 */
export function applyCompletenessGate(
  provisional: CandidateGrade,
  completeness: DataCompleteness,
  flags: string[],
): CandidateGrade {
  if (flags.includes('DISQUALIFIED')) return 'F';
  if (completeness === 'INSUFFICIENT_HISTORY') {
    // Cap at B — a thin/truncated wallet can never be a clean A.
    return provisional === 'A' || provisional === 'B' ? 'B' : provisional;
  }
  return provisional;
}

function buildRationale(
  grade: CandidateGrade,
  completeness: DataCompleteness,
  flags: string[],
  alerts: MonitorAlert[],
): string {
  const dangerCount = alerts.filter((a) => a.severity === 'danger').length;
  const parts: string[] = [`grade ${grade}`];
  if (completeness === 'INSUFFICIENT_HISTORY') {
    parts.push('INSUFFICIENT_HISTORY (capped — never a clean A)');
  }
  if (flags.includes('DISQUALIFIED')) parts.push('DISQUALIFIED');
  if (dangerCount > 0) parts.push(`${dangerCount} danger alert(s)`);
  if (flags.length > 0) parts.push(`flags: ${flags.join(', ')}`);
  return parts.join('; ');
}

/**
 * Grade a single candidate from its rating, live state and fills. PURE.
 *
 * `fillsSeen` is the number of fills the caller actually fetched — the gate input
 * (not the rating's historical `nFills`, which the caller may not have re-fetched
 * fully). The provisional grade comes from the rating dataset, then the
 * completeness gate is applied.
 */
export function gradeCandidate(
  wallet: RatedWallet,
  leaderState: HlClearinghouseState,
  fills: HlFill[],
): TraderCandidate {
  const fillsSeen = fills.length;
  const { completeness, reason } = assessDataCompleteness(fillsSeen);
  const provisional = bestRatedGrade(wallet);
  const grade = applyCompletenessGate(provisional, completeness, wallet.flags);
  const analytics = buildCopyMonitorAnalytics(wallet, leaderState, fills);

  return {
    address: wallet.address,
    short: wallet.short,
    displayName: wallet.displayName,
    grade,
    composite: wallet.composite,
    completeness,
    completenessReason: reason,
    flags: wallet.flags,
    alerts: analytics.alerts,
    fillsSeen,
    accountValueUsd: leaderState.accountValueUsd,
    rationale: buildRationale(grade, completeness, wallet.flags, analytics.alerts),
  };
}

const GRADE_RANK: Record<CandidateGrade, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };

/**
 * Rank candidates best → worst. PURE + deterministic.
 *
 * Sort key: grade (A first) → COMPLETE before INSUFFICIENT_HISTORY → higher
 * composite → fewer danger alerts → address (stable tiebreak). A COMPLETE B
 * therefore outranks an INSUFFICIENT_HISTORY B, reinforcing that thin data is a
 * demerit, not a wash.
 */
export function rankCandidates(candidates: TraderCandidate[]): TraderCandidate[] {
  const dangerCount = (c: TraderCandidate) =>
    c.alerts.filter((a) => a.severity === 'danger').length;
  return [...candidates].sort((a, b) => {
    if (GRADE_RANK[a.grade] !== GRADE_RANK[b.grade]) return GRADE_RANK[a.grade] - GRADE_RANK[b.grade];
    if (a.completeness !== b.completeness) return a.completeness === 'COMPLETE' ? -1 : 1;
    const ca = a.composite ?? -1;
    const cb = b.composite ?? -1;
    if (ca !== cb) return cb - ca;
    if (dangerCount(a) !== dangerCount(b)) return dangerCount(a) - dangerCount(b);
    return a.address.localeCompare(b.address);
  });
}
