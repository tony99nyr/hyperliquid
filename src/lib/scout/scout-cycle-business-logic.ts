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
