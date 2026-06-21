/**
 * pnpm scout:cycle — gather the decision snapshot for the (cheap-model) scout.
 *
 * NEVER trades + NEVER decides. It assembles everything the scout session needs
 * to reason in ONE place: recent triggers, the latest rubric reads, fresh marks,
 * open paper positions, the recent hypothesis track record (win/loss context for
 * the learning loop), and a pointer to the playbook. The model reads this, decides
 * per `.claude/skills/scout/SKILL.md`, and — only if a setup clears the bar —
 * calls `pnpm scout:trade` (paper). Otherwise it logs a stand-down + sleeps.
 */

import { readFileSync, existsSync } from 'node:fs';
import { header, line, run } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { gatherScoutInputs, scoutTriggerFilePath } from '@/lib/scout/scout-watch-service';
import { scoutPlaybookPath, summarizeHypotheses, type HypothesisSummaryRow } from '@/lib/scout/scout-cycle-business-logic';

/** Tail the JSONL trigger file (most recent N lines). */
function recentTriggers(n: number): string[] {
  const path = scoutTriggerFilePath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-n);
}

run(async () => {
  const now = Date.now();
  header(`scout:cycle — decision snapshot @ ${new Date(now).toISOString()}`);
  line('NEVER trades. Read this, consult the playbook, then decide per the scout skill.');

  // 1) Recent triggers (what woke us / what changed).
  const triggers = recentTriggers(12);
  header('TRIGGERS (most recent)');
  if (triggers.length === 0) line('(none — heartbeat wake; do a routine review)');
  else triggers.forEach((t) => line(t));

  // 2) Deterministic reads: rubric + marks + open paper positions.
  const inputs = await gatherScoutInputs(now);
  header('RUBRIC (newest per coin×side)');
  inputs.rubric
    .slice()
    .sort((a, b) => b.opportunity - a.opportunity)
    .forEach((r) => line(`${r.coin} ${r.side.padEnd(5)} opp=${Math.round(r.opportunity)} ${r.badge}`));

  header('MARKS');
  inputs.marks.forEach((m) => line(`${m.coin} = ${m.markPx}`));

  header('OPEN PAPER POSITIONS');
  if (inputs.positions.length === 0) line('(flat — no open positions)');
  else inputs.positions.forEach((p) => line(`${p.coin} ${p.side} health=${p.healthScore ?? '—'} mark=${p.markPx}`));

  // 3) Track record for the learning loop (win-rate by recent outcome) — scoped to
  // SCOUT sessions only, so the scout's self-assessment excludes manual trades.
  const client = getServiceRoleClient();
  const { data: scoutSessions } = await client.from('sessions').select('id').eq('title', 'scout');
  const scoutIds = (scoutSessions ?? []).map((s) => (s as { id: string }).id);
  let hypRows: HypothesisSummaryRow[] = [];
  if (scoutIds.length > 0) {
    const { data } = await client
      .from('hypotheses')
      .select('statement, status, resolution_note, created_at, resolved_at')
      .in('session_id', scoutIds)
      .order('created_at', { ascending: false })
      .limit(30);
    hypRows = (data ?? []) as HypothesisSummaryRow[];
  }
  const summary = summarizeHypotheses(hypRows);
  header('TRACK RECORD (recent hypotheses)');
  line(`open=${summary.open}  confirmed=${summary.confirmed}  invalidated=${summary.invalidated}  resolved=${summary.resolved}`);
  if (summary.lastResolved.length > 0) {
    line('last resolved:');
    summary.lastResolved.forEach((h) => line(`  [${h.status}] ${h.statement}${h.resolutionNote ? ` — ${h.resolutionNote}` : ''}`));
  }

  // 4) Playbook pointer (the durable, curated memory the scout MUST read).
  header('PLAYBOOK');
  const pb = scoutPlaybookPath();
  line(existsSync(pb) ? `Read + apply: ${pb}` : `(missing — create ${pb})`);

  header('NEXT');
  line('Decide per .claude/skills/scout/SKILL.md. Trade (paper) only if a setup clears the bar; else stand down + note why.');
});
