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
});
