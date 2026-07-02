/**
 * ladder-expectancy — PURE outcome-resolution + expectancy math (fixture-tested).
 *
 * The operator-lane feedback loop the scout lane already has (ADR-0005): every terminal
 * ladder resolves to ONE outcome row (planned slip-aware risk vs HL-realized PnL → an
 * R-multiple), and the weekly review rolls outcomes up per setup type against a
 * PRE-REGISTERED bar → KILL / HOLD / SIZE-UP / COLLECT. Without this loop you cannot
 * distinguish profitable-by-skill from profitable-by-luck.
 *
 * No I/O. Realized PnL comes from HL's OWN fills (closedPnl, net of fee when present) —
 * the app's fills table can't see exchange-side stop/TP fills. Attribution is per-coin
 * over the ladder's active window, which is sound under the playbook's one-active-
 * campaign-per-coin rule (§5b); overlapping same-coin trades would blur it (flagged).
 */

import type { LadderWithRungs } from '@/lib/ladder/ladder-types';
import type { HlFill } from '@/lib/hyperliquid/hyperliquid-info-service';

export type LadderOutcomeClass = 'never_filled' | 'open' | 'won' | 'lost' | 'scratch';

export interface LadderOutcomeRow {
  ladderId: string;
  title: string;
  coin: string;
  side: 'long' | 'short';
  mode: 'paper' | 'live';
  setupType: string;
  signalScore: number | null;
  timingScore: number | null;
  plannedRiskUsd: number;
  realizedPnlUsd: number | null;
  feesUsd: number | null;
  realizedR: number | null;
  outcome: LadderOutcomeClass;
  windowStartMs: number;
  windowEndMs: number | null;
  notes: string | null;
}

/** |realizedR| at or under this is a scratch (noise), not a win/loss. */
export const SCRATCH_R = 0.05;

/** Derive a stable setup tag from the rung shape — the grouping key for expectancy. */
export function deriveSetupType(ladder: Pick<LadderWithRungs, 'rungs'>): string {
  const opens = ladder.rungs.filter((r) => r.action === 'open');
  const hasAdd = ladder.rungs.some((r) => r.action === 'add');
  const side = opens[0]?.side ?? ladder.rungs[0]?.side ?? 'long';
  const kind = opens[0]?.triggerKind ?? 'price_above';
  const dir = side === 'long'
    ? (kind === 'price_above' ? 'breakout' : 'dip')
    : (kind === 'price_below' ? 'breakdown' : 'fade');
  return `${dir}-${side}-${hasAdd ? 'pyramid' : 'single'}`;
}

export interface ResolveOutcomeInput {
  ladder: LadderWithRungs;
  /** ladder_fires statuses for this ladder (only 'filled' counts as an entry happening). */
  fireStatuses: string[];
  /** HL fills for the OWNER account (any coin — filtered here), or null when unavailable
   *  (no address / paper): realized stays null unless the ladder never filled. */
  hlFills: HlFill[] | null;
  /** Slip-aware no-netting worst case (computeLadderRisk) — the planned R denominator. */
  plannedRiskUsd: number;
  /** True when the ladder's coin still has a live position (outcome stays 'open'). */
  positionStillOpen: boolean;
  signalScore?: number | null;
  timingScore?: number | null;
  now: number;
}

/** Resolve one terminal (or fired-and-still-open) ladder into an outcome row. PURE. */
export function resolveLadderOutcome(input: ResolveOutcomeInput): LadderOutcomeRow {
  const { ladder, now } = input;
  const coin = (ladder.rungs[0]?.coin ?? '').toUpperCase();
  const side = ladder.rungs.find((r) => r.action === 'open')?.side ?? ladder.rungs[0]?.side ?? 'long';
  const windowStartMs = Date.parse(ladder.armedAt ?? ladder.createdAt);
  const anyFilled = input.fireStatuses.some((s) => s === 'filled');

  const base = {
    ladderId: ladder.id,
    title: ladder.title,
    coin,
    side,
    mode: ladder.mode,
    setupType: deriveSetupType(ladder),
    signalScore: input.signalScore ?? null,
    timingScore: input.timingScore ?? null,
    plannedRiskUsd: input.plannedRiskUsd,
    windowStartMs,
  };

  if (!anyFilled) {
    return { ...base, realizedPnlUsd: 0, feesUsd: 0, realizedR: 0, outcome: 'never_filled', windowEndMs: ladder.disarmedAt ? Date.parse(ladder.disarmedAt) : now, notes: 'No entry rung ever filled — costless pass (selectivity, not a loss).' };
  }
  if (input.positionStillOpen) {
    return { ...base, realizedPnlUsd: null, feesUsd: null, realizedR: null, outcome: 'open', windowEndMs: null, notes: 'Position still live — re-resolve once flat.' };
  }
  if (input.hlFills == null) {
    return { ...base, realizedPnlUsd: null, feesUsd: null, realizedR: null, outcome: 'open', windowEndMs: null, notes: 'HL fills unavailable (no account address) — cannot resolve realized PnL yet.' };
  }

  // Realized: Σ closedPnl − Σ fee for this coin inside [windowStart, now]. HL's closedPnl
  // is the realized PnL on closing fills (excl. fees); fee is per-fill when HL sends it.
  const inWindow = input.hlFills.filter((f) => f.coin.toUpperCase() === coin && f.time >= windowStartMs && f.time <= now);
  const gross = inWindow.reduce((a, f) => a + (f.closedPnl ?? 0), 0);
  const fees = inWindow.reduce((a, f) => a + (f.fee ?? 0), 0);
  const net = gross - fees;
  const r = input.plannedRiskUsd > 0 ? net / input.plannedRiskUsd : null;
  const outcome: LadderOutcomeClass = r == null ? 'scratch' : r > SCRATCH_R ? 'won' : r < -SCRATCH_R ? 'lost' : 'scratch';
  return {
    ...base,
    realizedPnlUsd: Math.round(net * 100) / 100,
    feesUsd: Math.round(fees * 100) / 100,
    realizedR: r == null ? null : Math.round(r * 100) / 100,
    outcome,
    windowEndMs: now,
    notes: inWindow.length === 0 ? 'Entry fired but no HL fills found in the window — check attribution.' : null,
  };
}

/* ------------------------- weekly expectancy report ------------------------- */

/** PRE-REGISTERED bar (decide the rules BEFORE seeing the data — the scout-review
 *  discipline). Changing these after the fact to keep a setup alive is the failure mode. */
export interface ExpectancyBar {
  /** Closed trades needed before any verdict beyond COLLECT. */
  minTrades: number;
  /** Mean realized R at/below this (with n ≥ minTrades) ⇒ KILL the setup. */
  killExpectancyR: number;
  /** Mean realized R at/above this (with n ≥ minTrades) ⇒ earn a size-up. */
  sizeUpExpectancyR: number;
}

export const DEFAULT_EXPECTANCY_BAR: ExpectancyBar = {
  minTrades: 10,
  killExpectancyR: -0.05,
  sizeUpExpectancyR: 0.15,
};

export type SetupVerdict = 'COLLECT' | 'KILL' | 'HOLD' | 'SIZE-UP';

export interface SetupExpectancy {
  setupType: string;
  closedTrades: number;
  wins: number;
  losses: number;
  scratches: number;
  neverFilled: number;
  open: number;
  winRate: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  /** Mean realized R across ALL closed trades — the number that decides the verdict. */
  expectancyR: number | null;
  totalPnlUsd: number;
  verdict: SetupVerdict;
  reason: string;
}

export interface ExpectancyReport {
  perSetup: SetupExpectancy[];
  totals: { closedTrades: number; totalPnlUsd: number; expectancyR: number | null };
}

/** Roll outcomes up per setup type and verdict each against the bar. PURE. */
export function buildExpectancyReport(outcomes: LadderOutcomeRow[], bar: ExpectancyBar = DEFAULT_EXPECTANCY_BAR): ExpectancyReport {
  const bySetup = new Map<string, LadderOutcomeRow[]>();
  for (const o of outcomes) (bySetup.get(o.setupType) ?? bySetup.set(o.setupType, []).get(o.setupType)!).push(o);

  const perSetup: SetupExpectancy[] = [];
  for (const [setupType, rows] of [...bySetup.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const closed = rows.filter((o) => o.outcome === 'won' || o.outcome === 'lost' || o.outcome === 'scratch');
    const wins = closed.filter((o) => o.outcome === 'won');
    const losses = closed.filter((o) => o.outcome === 'lost');
    const rs = closed.map((o) => o.realizedR).filter((r): r is number => r != null);
    const expectancyR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
    const winRs = wins.map((o) => o.realizedR).filter((r): r is number => r != null);
    const lossRs = losses.map((o) => o.realizedR).filter((r): r is number => r != null);
    const totalPnl = closed.reduce((a, o) => a + (o.realizedPnlUsd ?? 0), 0);

    let verdict: SetupVerdict;
    let reason: string;
    if (closed.length < bar.minTrades) {
      verdict = 'COLLECT';
      reason = `${closed.length}/${bar.minTrades} closed trades — not enough sample for a verdict; keep size at the floor.`;
    } else if (expectancyR != null && expectancyR <= bar.killExpectancyR) {
      verdict = 'KILL';
      reason = `Expectancy ${expectancyR.toFixed(2)}R ≤ ${bar.killExpectancyR}R over ${closed.length} trades — the setup does not pay; stop trading it.`;
    } else if (expectancyR != null && expectancyR >= bar.sizeUpExpectancyR) {
      verdict = 'SIZE-UP';
      reason = `Expectancy ${expectancyR.toFixed(2)}R ≥ +${bar.sizeUpExpectancyR}R over ${closed.length} trades — earned one risk-tier step (e.g. 1% → 2%). Never more than one step at a time.`;
    } else {
      verdict = 'HOLD';
      reason = `Expectancy ${expectancyR?.toFixed(2) ?? '—'}R over ${closed.length} trades — between the kill and size-up bars; keep trading at current size.`;
    }

    perSetup.push({
      setupType,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      scratches: closed.length - wins.length - losses.length,
      neverFilled: rows.filter((o) => o.outcome === 'never_filled').length,
      open: rows.filter((o) => o.outcome === 'open').length,
      winRate: closed.length ? wins.length / closed.length : null,
      avgWinR: winRs.length ? winRs.reduce((a, b) => a + b, 0) / winRs.length : null,
      avgLossR: lossRs.length ? lossRs.reduce((a, b) => a + b, 0) / lossRs.length : null,
      expectancyR,
      totalPnlUsd: Math.round(totalPnl * 100) / 100,
      verdict,
      reason,
    });
  }

  const allClosed = outcomes.filter((o) => o.outcome === 'won' || o.outcome === 'lost' || o.outcome === 'scratch');
  const allRs = allClosed.map((o) => o.realizedR).filter((r): r is number => r != null);
  return {
    perSetup,
    totals: {
      closedTrades: allClosed.length,
      totalPnlUsd: Math.round(allClosed.reduce((a, o) => a + (o.realizedPnlUsd ?? 0), 0) * 100) / 100,
      expectancyR: allRs.length ? allRs.reduce((a, b) => a + b, 0) / allRs.length : null,
    },
  };
}
