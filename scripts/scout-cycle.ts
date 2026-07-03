/**
 * pnpm scout:cycle — gather the decision snapshot for the (cheap-model) scout.
 *
 * NEVER trades + NEVER decides. It assembles everything the scout needs to reason in
 * ONE place: unconsumed triggers (from the ScoutTriggerSink, cursor-stamped so churn
 * doesn't re-surface), the latest rubric reads, fresh marks, funding/OI, vaults, open
 * paper positions, the circuit breaker, the hypothesis track record, and the playbook
 * pointer.
 *
 * Two renderings of the SAME snapshot:
 *   - default: human/model-readable prose (the interactive scout session).
 *   - --json:  one machine-readable JSON object on stdout (the HEADLESS contract —
 *     scripts/scout-headless.sh pipes it to a `claude -p` decision, whose output goes
 *     to `pnpm scout:trade --from-json`). See .claude/skills/scout/SKILL.md.
 *
 * Each run upserts a CONSUMER heartbeat (source 'scout-cycle') — a dead consumer is
 * visible in the cockpit instead of masquerading as "0 triggers" (the Jun-24 lesson).
 */

import { existsSync } from 'node:fs';
import { header, line, run } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { fetchMetaAndAssetCtxs } from '@/lib/hyperliquid/hyperliquid-info-service';
import { gatherScoutInputs, writeScoutHeartbeat } from '@/lib/scout/scout-watch-service';
import { recentTriggers, markTriggersConsumed, pruneConsumedTriggers, type SinkTrigger } from '@/lib/scout/scout-trigger-sink';
import { checkCircuitBreaker } from '@/lib/risk/circuit-breaker-service';
import { scoutPlaybookPath, summarizeHypotheses, type HypothesisSummaryRow } from '@/lib/scout/scout-cycle-business-logic';

interface VaultRow { vault_address: string; name: string; kind: string; nav_usd: number | null; apr_annual: number | null; max_drawdown_pct: number | null; age_days: number | null; leader_fraction: number | null }

run(async () => {
  const jsonMode = process.argv.includes('--json');
  const now = Date.now();

  // 1) Read UNCONSUMED triggers (the wake reasons) — claimed AFTER the gather succeeds,
  // so a crash mid-gather leaves them for the next wake (consume-late).
  const candidates: SinkTrigger[] = await recentTriggers(12, { unconsumedOnly: true });

  // 2) Deterministic reads: rubric + marks + open paper positions (+ degradation gate).
  const inputs = await gatherScoutInputs(now);

  // 3) ATOMIC claim: only rows WE stamped are ours (a concurrent consumer gets a disjoint
  // set — no double-trade on the same signal). Unclaimed rows are dropped from THIS view.
  const claimed = await markTriggersConsumed(candidates.map((t) => t.id), now);
  const triggers = candidates.filter((t) => t.id == null || claimed.has(t.id));
  // Retention: keep the table bounded (consumed rows older than 14d), like JSONL rotation.
  await pruneConsumedTriggers(14 * 24 * 3_600_000, now);

  // 3) Funding / OI / premium context (judgment inputs, not auto-scored).
  const ctxs = await fetchMetaAndAssetCtxs().catch(() => ({} as Record<string, { fundingHourly: number; openInterest: number; premium: number }>));
  const fundingCtx = inputs.marks
    .filter((m) => ctxs[m.coin])
    .map((m) => ({ coin: m.coin, fundingHourly: ctxs[m.coin].fundingHourly, openInterest: ctxs[m.coin].openInterest, premium: ctxs[m.coin].premium }));

  // 4) Vaults (Lane A allocation candidates — newest snapshot per vault).
  const db = getServiceRoleClient();
  const { data: vaultRows } = await db
    .from('vault_snapshots')
    .select('vault_address, name, kind, nav_usd, apr_annual, max_drawdown_pct, age_days, leader_fraction, fetched_at')
    .order('fetched_at', { ascending: false })
    .limit(50);
  const latestByVault = new Map<string, VaultRow>();
  for (const v of (vaultRows ?? []) as VaultRow[]) if (!latestByVault.has(v.vault_address)) latestByVault.set(v.vault_address, v);
  const vaults = [...latestByVault.values()];

  // 5) Circuit breaker (HALTED ⇒ no new entries; exits always allowed).
  const breaker = await checkCircuitBreaker('scout', now);

  // 6) Track record (scout sessions only — self-assessment excludes manual trades).
  const { data: scoutSessions } = await db.from('sessions').select('id').eq('title', 'scout');
  const scoutIds = (scoutSessions ?? []).map((s) => (s as { id: string }).id);
  let hypRows: HypothesisSummaryRow[] = [];
  if (scoutIds.length > 0) {
    const { data } = await db
      .from('hypotheses')
      .select('statement, status, resolution_note, created_at, resolved_at')
      .in('session_id', scoutIds)
      .order('created_at', { ascending: false })
      .limit(30);
    hypRows = (data ?? []) as HypothesisSummaryRow[];
  }
  const summary = summarizeHypotheses(hypRows);
  const playbookPath = scoutPlaybookPath();

  // CONSUMER liveness — distinct from the producer's 'scout-watch' row. A dead consumer
  // is now a stale row in the cockpit, not silence.
  await writeScoutHeartbeat(inputs.degraded ? 'degraded' : 'ok', `${triggers.length} trigger(s) consumed${inputs.degraded ? ` — ${inputs.degradedReason}` : ''}`, 'scout-cycle', now);

  if (jsonMode) {
    // The HEADLESS contract: one JSON object, stable field names. The decision model
    // replies with {action:'open'|'close'|'stand-down', ...} → scout:trade --from-json.
    const snapshot = {
      at: new Date(now).toISOString(),
      degraded: inputs.degraded,
      degradedReason: inputs.degradedReason,
      triggers: triggers.map((t) => ({ kind: t.kind, coin: t.coin, side: t.side ?? null, urgency: t.urgency, detail: t.detail, at: new Date(t.at).toISOString() })),
      rubric: inputs.rubric.map((r) => ({ coin: r.coin, side: r.side, opportunity: Math.round(r.opportunity), badge: r.badge })),
      marks: inputs.marks,
      funding: fundingCtx,
      vaults,
      positions: inputs.positions,
      circuitBreaker: { halted: breaker.blockNewEntries, reason: breaker.reason, equityUsd: breaker.equityUsd, peakEquityUsd: breaker.peakEquityUsd, dayStartEquityUsd: breaker.dayStartEquityUsd, flattenRecommended: breaker.flattenRecommended },
      trackRecord: { open: summary.open, confirmed: summary.confirmed, invalidated: summary.invalidated, resolved: summary.resolved, lastResolved: summary.lastResolved },
      playbookPath: existsSync(playbookPath) ? playbookPath : null,
    };
    // Raw stdout (no header/line decoration) — this IS the machine contract.
    console.log(JSON.stringify(snapshot));
    return;
  }

  header(`scout:cycle — decision snapshot @ ${new Date(now).toISOString()}`);
  line('NEVER trades. Read this, consult the playbook, then decide per the scout skill.');

  header('TRIGGERS (unconsumed — your wake reasons; now cursor-stamped)');
  if (triggers.length === 0) line('(none — heartbeat wake; do a routine review)');
  else triggers.forEach((t) => line(`${new Date(t.at).toISOString()} [${t.urgency}] ${t.kind} ${t.coin}${t.side ? ` ${t.side}` : ''} — ${t.detail}`));

  if (inputs.degraded) {
    header('⏸ FEED DEGRADED — STAND DOWN');
    line(`Reason: ${inputs.degradedReason}. Do NOT open a trade on this snapshot.`);
    line('Manage existing positions conservatively (favor safety); wait for a fresh feed before any entry.');
  }
  header('RUBRIC (newest per coin×side)');
  inputs.rubric
    .slice()
    .sort((a, b) => b.opportunity - a.opportunity)
    .forEach((r) => line(`${r.coin} ${r.side.padEnd(5)} opp=${Math.round(r.opportunity)} ${r.badge}`));

  header('MARKS');
  inputs.marks.forEach((m) => line(`${m.coin} = ${m.markPx}`));

  header('FUNDING / OI / PREMIUM (context — for judgment, not auto-scored)');
  for (const c of fundingCtx) {
    const apr = (c.fundingHourly * 24 * 365 * 100).toFixed(1);
    const who = c.fundingHourly >= 0 ? 'longs pay / shorts earn' : 'shorts pay / longs earn';
    line(`${c.coin}  funding ${(c.fundingHourly * 100).toFixed(4)}%/h (~${apr}% APR; ${who})  OI=${Math.round(c.openInterest)}  premium=${(c.premium * 100).toFixed(3)}%`);
  }

  header('VAULTS (Lane A — allocation candidates; nav = total AUM, judge on apr/return)');
  if (vaults.length === 0) line('(no vault snapshots yet — wait for the nas-watch tick / run pnpm vault-watch --once)');
  else for (const v of vaults) {
    const pct = (x: number | null, d = 2) => (x != null ? `${(x * 100).toFixed(d)}%` : '?');
    line(`${v.name} [${v.kind}]  NAV $${v.nav_usd != null ? Math.round(v.nav_usd).toLocaleString('en-US') : '?'}  apr ${pct(v.apr_annual)}  dd ${pct(v.max_drawdown_pct, 1)}  age ${v.age_days != null ? Math.round(v.age_days) + 'd' : '?'}  leaderStake ${pct(v.leader_fraction)}`);
  }

  header('OPEN PAPER POSITIONS');
  if (inputs.positions.length === 0) line('(flat — no open positions)');
  else inputs.positions.forEach((p) => line(`${p.coin} ${p.side} health=${p.healthScore ?? '—'} mark=${p.markPx}`));

  header('CIRCUIT BREAKER');
  line(`equity=$${breaker.equityUsd.toFixed(0)} (peak $${breaker.peakEquityUsd.toFixed(0)}, dayStart $${breaker.dayStartEquityUsd.toFixed(0)})`);
  line(breaker.blockNewEntries ? `⛔ HALTED — ${breaker.reason} → NO new entries${breaker.flattenRecommended ? ' + flatten recommended' : ''}` : `✓ ${breaker.reason}`);

  header('TRACK RECORD (recent hypotheses)');
  line(`open=${summary.open}  confirmed=${summary.confirmed}  invalidated=${summary.invalidated}  resolved=${summary.resolved}`);
  if (summary.lastResolved.length > 0) {
    line('last resolved:');
    summary.lastResolved.forEach((h) => line(`  [${h.status}] ${h.statement}${h.resolutionNote ? ` — ${h.resolutionNote}` : ''}`));
  }

  header('PLAYBOOK');
  line(existsSync(playbookPath) ? `Read + apply: ${playbookPath}` : `(missing — create ${playbookPath})`);

  header('NEXT');
  line('Decide per .claude/skills/scout/SKILL.md. Trade (paper) only if a setup clears the bar; else stand down + note why.');
});
