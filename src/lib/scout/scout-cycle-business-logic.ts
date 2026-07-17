/**
 * PURE helpers for the scout cycle snapshot. Summarize the recent hypothesis
 * track record (the learning-loop context the scout reads before deciding) and
 * locate the curated playbook. No I/O beyond cwd resolution. Fixture-tested.
 */

import { join } from 'node:path';

export interface HypothesisSummaryRow {
  statement: string;
  status: string;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface HypothesisSummary {
  open: number;
  confirmed: number;
  invalidated: number;
  resolved: number;
  /** The most-recent terminal hypotheses, newest first (for at-a-glance context). */
  lastResolved: Array<{ statement: string; status: string; resolutionNote: string | null }>;
}

/** Count by status + surface the latest few resolved theses. Input newest-first. */
export function summarizeHypotheses(rows: HypothesisSummaryRow[], lastN = 5): HypothesisSummary {
  const summary: HypothesisSummary = { open: 0, confirmed: 0, invalidated: 0, resolved: 0, lastResolved: [] };
  for (const r of rows) {
    if (r.status === 'open') summary.open++;
    else if (r.status === 'confirmed') summary.confirmed++;
    else if (r.status === 'invalidated') summary.invalidated++;
    else if (r.status === 'resolved') summary.resolved++;
  }
  summary.lastResolved = rows
    .filter((r) => r.status !== 'open')
    .slice(0, lastN)
    .map((r) => ({ statement: r.statement, status: r.status, resolutionNote: r.resolution_note }));
  return summary;
}

/** Path to the curated playbook the scout reads + the review curates. */
export function scoutPlaybookPath(cwd: string = process.cwd()): string {
  return join(cwd, 'docs', 'scout', 'playbook.md');
}

/* ------------------- headless decision contract (C2, 2026-07-03) ------------------- */

/** Hard per-decision paper risk cap for the HEADLESS path — a model that asks for more
 *  is rejected before anything trades (defense against a runaway/hallucinated size). */
export const SCOUT_MAX_RISK_USD = 500;

/** The decision the headless scout model returns for ONE cycle. Exactly one action.
 *  'stand-down' is a first-class outcome (most cycles) — it carries the why. */
export interface ScoutDecision {
  action: 'open' | 'close' | 'stand-down' | 'propose';
  /** propose: short headline for the Discord page. */
  title?: string;
  /** propose: the concrete ladder change + rationale (goes to the operator verbatim). */
  body?: string;
  /** open/close */
  coin?: string;
  /** open: buy|sell */
  side?: string;
  riskUsd?: number;
  stopFrac?: number;
  leverage?: number;
  lane?: string;
  /** open: the hypothesis being tested (required — the track record is the product). */
  thesis?: string;
  /** close */
  sessionId?: string;
  hypothesisId?: string;
  fraction?: number;
  /** stand-down / close: the reason (logged). */
  note?: string;
  setupType?: string;
  regime?: string;
  proposalKind?: string;
  paramPx?: number;
}

/**
 * Parse + validate a headless decision JSON into the scout:trade arg record (the same
 * shape the CLI flags produce), or a stand-down/error. PURE — fixture-tested; the thin
 * script routes the result. Validation is strict: a malformed decision NEVER trades.
 */
export function parseScoutDecision(raw: string): { kind: 'open' | 'close'; args: Record<string, string | boolean> } | { kind: 'stand-down'; note: string } | { kind: 'propose'; title: string; body: string; coin: string | null; proposalKind: 'exit' | 'bank' | 'stop-tighten' | 'disarm' | 'widen-target' | 'info'; paramPx: number | null } | { kind: 'error'; error: string } {
  let d: ScoutDecision;
  try {
    d = JSON.parse(raw) as ScoutDecision;
  } catch {
    return { kind: 'error', error: 'decision is not valid JSON' };
  }
  if (d == null || typeof d !== 'object') return { kind: 'error', error: 'decision must be a JSON object' };
  if (d.action === 'stand-down') return { kind: 'stand-down', note: d.note ?? '(no reason given)' };
  // STEWARD lane: a ladder-management PROPOSAL — pages the operator + logs; NEVER
  // executes anything. This is how the scout advises on the LIVE book it can see
  // read-only but must never touch.
  if (d.action === 'propose') {
    if (!d.title || typeof d.title !== 'string') return { kind: 'error', error: 'propose: title required' };
    if (!d.body || typeof d.body !== 'string') return { kind: 'error', error: 'propose: body required (the concrete ladder change + rationale)' };
    // Counterfactual contract (Jul-17): a scorable proposal declares its KIND and
    // (for stop-tighten/widen-target) the concrete price. Missing/unknown kind
    // degrades to 'info' — recorded, never scored, never rejected.
    const KINDS = ['exit', 'bank', 'stop-tighten', 'disarm', 'widen-target', 'info'] as const;
    const proposalKind = KINDS.includes(d.proposalKind as (typeof KINDS)[number]) ? (d.proposalKind as (typeof KINDS)[number]) : 'info';
    const paramPx = typeof d.paramPx === 'number' && Number.isFinite(d.paramPx) && d.paramPx > 0 ? d.paramPx : null;
    if ((proposalKind === 'stop-tighten' || proposalKind === 'widen-target') && paramPx == null) {
      return { kind: 'error', error: `propose: ${proposalKind} requires a concrete paramPx` };
    }
    return { kind: 'propose', title: d.title.slice(0, 120), body: d.body.slice(0, 1200), coin: typeof d.coin === 'string' ? d.coin.toUpperCase() : null, proposalKind, paramPx };
  }
  if (d.action === 'open') {
    if (!d.coin || typeof d.coin !== 'string') return { kind: 'error', error: 'open: coin required' };
    if (d.side !== 'buy' && d.side !== 'sell') return { kind: 'error', error: 'open: side must be buy|sell' };
    if (typeof d.riskUsd !== 'number' || !Number.isFinite(d.riskUsd) || !(d.riskUsd > 0) || d.riskUsd > SCOUT_MAX_RISK_USD) {
      return { kind: 'error', error: `open: riskUsd must be finite, > 0 and <= ${SCOUT_MAX_RISK_USD} (paper cap)` };
    }
    if (typeof d.stopFrac !== 'number' || !Number.isFinite(d.stopFrac) || !(d.stopFrac > 0 && d.stopFrac < 1)) return { kind: 'error', error: 'open: stopFrac must be finite, in (0,1)' };
    if (!d.thesis || typeof d.thesis !== 'string') return { kind: 'error', error: 'open: thesis required (the hypothesis is the product)' };
    const args: Record<string, string | boolean> = {
      coin: d.coin, side: d.side, risk: String(d.riskUsd), 'stop-frac': String(d.stopFrac), thesis: d.thesis,
    };
    if (typeof d.leverage === 'number' && Number.isFinite(d.leverage) && d.leverage >= 1) args['leverage'] = String(d.leverage);
    if (typeof d.lane === 'string' && d.lane.trim()) args['lane'] = d.lane.trim();
    // Structured trial fields (Jul-16 review) — optional, bounded, advisory metadata.
    if (typeof d.setupType === 'string' && d.setupType.trim()) args['setup-type'] = d.setupType.trim().slice(0, 40);
    if (typeof d.regime === 'string' && d.regime.trim()) args['regime'] = d.regime.trim().slice(0, 40);
    return { kind: 'open', args };
  }
  if (d.action === 'close') {
    if (!d.coin || typeof d.coin !== 'string') return { kind: 'error', error: 'close: coin required' };
    if (!d.sessionId || typeof d.sessionId !== 'string') return { kind: 'error', error: 'close: sessionId required' };
    const args: Record<string, string | boolean> = { exit: true, coin: d.coin, session: d.sessionId };
    if (typeof d.hypothesisId === 'string') args['hypothesis'] = d.hypothesisId;
    if (typeof d.note === 'string') args['note'] = d.note;
    if (typeof d.fraction === 'number' && d.fraction > 0 && d.fraction <= 1) args['fraction'] = String(d.fraction);
    return { kind: 'close', args };
  }
  return { kind: 'error', error: `unknown action ${String((d as { action?: unknown }).action)}` };
}
