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

/** The decision the headless scout model returns for ONE cycle. Exactly one action.
 *  'stand-down' is a first-class outcome (most cycles) — it carries the why. */
export interface ScoutDecision {
  action: 'open' | 'close' | 'stand-down';
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
}

/**
 * Parse + validate a headless decision JSON into the scout:trade arg record (the same
 * shape the CLI flags produce), or a stand-down/error. PURE — fixture-tested; the thin
 * script routes the result. Validation is strict: a malformed decision NEVER trades.
 */
export function parseScoutDecision(raw: string): { kind: 'open' | 'close'; args: Record<string, string | boolean> } | { kind: 'stand-down'; note: string } | { kind: 'error'; error: string } {
  let d: ScoutDecision;
  try {
    d = JSON.parse(raw) as ScoutDecision;
  } catch {
    return { kind: 'error', error: 'decision is not valid JSON' };
  }
  if (d.action === 'stand-down') return { kind: 'stand-down', note: d.note ?? '(no reason given)' };
  if (d.action === 'open') {
    if (!d.coin || typeof d.coin !== 'string') return { kind: 'error', error: 'open: coin required' };
    if (d.side !== 'buy' && d.side !== 'sell') return { kind: 'error', error: 'open: side must be buy|sell' };
    if (typeof d.riskUsd !== 'number' || !(d.riskUsd > 0)) return { kind: 'error', error: 'open: riskUsd must be > 0' };
    if (typeof d.stopFrac !== 'number' || !(d.stopFrac > 0 && d.stopFrac < 1)) return { kind: 'error', error: 'open: stopFrac must be in (0,1)' };
    if (!d.thesis || typeof d.thesis !== 'string') return { kind: 'error', error: 'open: thesis required (the hypothesis is the product)' };
    const args: Record<string, string | boolean> = {
      coin: d.coin, side: d.side, risk: String(d.riskUsd), 'stop-frac': String(d.stopFrac), thesis: d.thesis,
    };
    if (typeof d.leverage === 'number' && d.leverage >= 1) args['leverage'] = String(d.leverage);
    if (typeof d.lane === 'string' && d.lane.trim()) args['lane'] = d.lane.trim();
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
