/**
 * pnpm scout:review — the deterministic scorecard for the paper scout (terminal).
 *
 * NEVER trades + NEVER edits the playbook. Thin printer over the shared
 * `lane-scorecard-service` (the SINGLE compute point, so this terminal output and
 * the persisted cockpit snapshot show identical numbers). It prints the
 * account-level NET + verdict (the pre-registered bar) and the per-lane breakdown
 * (directional + vault/carry BENCHMARKS). The `scout-review` SKILL then has Opus
 * read this + the resolved hypotheses and curate docs/scout/playbook.md.
 */

import { header, line, run } from './_skill-runtime';
import { computeScoutLaneCards } from '@/lib/scout/lane-scorecard-service';

run(async () => {
  header('scout:review — paper scorecard (deterministic; never trades)');
  const { account, lanes, hasSessions } = await computeScoutLaneCards();

  if (!hasSessions) {
    line('No active scout sessions — the directional lane is empty (fresh book). The');
    line('vault + carry BENCHMARK lanes below still score (they are passive, not traded).');
  }

  header('SCORECARD');
  line(`period: ${account.periodDays.toFixed(1)} days   trades: ${account.tradeCount}   win-rate: ${(account.winRate * 100).toFixed(0)}%   (open positions: ${account.openCount})`);
  line(`realized (net of fees + slippage-in-fill): $${account.realizedUsd.toFixed(2)}`);
  line(`${account.fundingUsd >= 0 ? '−' : '+'} funding ${account.fundingUsd >= 0 ? 'cost' : 'CARRY earned'} (signed, per-coin): $${Math.abs(account.fundingUsd).toFixed(2)}`);
  line(`= NET: $${account.netUsd.toFixed(2)}`);
  line(`monthly run-rate: $${account.monthlyRunRateUsd.toFixed(0)}/mo`);
  header(`VERDICT: ${account.verdict.toUpperCase()} (ALL LANES — the account-level bar)`);
  line(account.label);

  if (lanes.length > 0) {
    header('PER-LANE BREAKDOWN');
    for (const l of lanes) {
      line(`[${l.lane}]  net $${l.netUsd.toFixed(2)}  run-rate $${l.monthlyRunRateUsd.toFixed(0)}/mo  → ${l.verdict.toUpperCase()}   ${l.label}`);
    }
  }
  line('');
  line('Next: the scout-review skill (Opus) reads this + the resolved hypotheses and curates docs/scout/playbook.md.');

  // Steward counterfactual score — "would its advice have helped?" (Jul-17).
  try {
    const { getServiceRoleClient } = await import('@/lib/cockpit/supabase-server');
    const { stewardScore } = await import('@/lib/scout/steward-proposal-business-logic');
    const { data: props } = await getServiceRoleClient()
      .from('steward_proposals')
      .select('status, helped_usd')
      .limit(500);
    const sc = stewardScore((props ?? []).map((r) => ({ status: String((r as { status: string }).status), helpedUsd: (r as { helped_usd: number | null }).helped_usd })));
    header('STEWARD COUNTERFACTUALS (proposals scored against what actually happened)');
    if (sc.resolved === 0) line('(no resolved proposals yet)');
    else line(`resolved ${sc.resolved} (scorable ${sc.scorable}) · helped ${sc.helpedCount} / hurt ${sc.hurtCount} · net if-followed $${sc.netHelpedUsd.toFixed(2)}`);
  } catch { /* advisory display only */ }

  // Persist the run (Jul-16 review: the judge had NEVER run and left no evidence
  // when it did — now every run writes a scout_reviews row). Best-effort.
  try {
    const { getServiceRoleClient } = await import('@/lib/cockpit/supabase-server');
    const report = [
      `period ${account.periodDays.toFixed(1)}d · trades ${account.tradeCount} · win-rate ${(account.winRate * 100).toFixed(0)}%`,
      `net $${account.netUsd.toFixed(2)} · run-rate $${account.monthlyRunRateUsd.toFixed(0)}/mo`,
      ...lanes.map((l) => `[${l.lane}] net $${l.netUsd.toFixed(2)} → ${l.verdict}: ${l.label}`),
    ].join('\n');
    await getServiceRoleClient().from('scout_reviews').insert({
      verdict: account.verdict,
      trade_count: account.tradeCount,
      net_usd: account.netUsd,
      report,
    });
    line('(review persisted to scout_reviews)');
  } catch (e) {
    line(`WARN: review not persisted: ${e instanceof Error ? e.message : String(e)}`);
  }
});
