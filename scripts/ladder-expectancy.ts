/**
 * skill:ladder-expectancy entrypoint (thin I/O). ADVISORY ONLY — never trades/arms.
 *
 * The operator-lane feedback loop: (1) RESOLVE — every terminal ladder (done / disarmed /
 * expired) gets an outcome row (planned slip-aware risk vs HL-realized PnL → R-multiple);
 * (2) REPORT — roll outcomes up per setup type against the PRE-REGISTERED expectancy bar
 * → KILL / HOLD / SIZE-UP / COLLECT. Run weekly (and after any ladder closes).
 *
 * Realized PnL uses HL's OWN fills (closedPnl − fee) because exchange-side stop/TP fills
 * never pass through the app. Requires HL_ACCOUNT_ADDRESS for live resolution; without it,
 * only never_filled outcomes resolve (the rest stay 'open' pending an address).
 *
 * Usage:
 *   pnpm skill:ladder-expectancy [--report-only] [--signal <0-10> --timing <0-10> --ladder <id>] [--session <id>]
 */

import { parseArgs, header, line, run } from './_skill-runtime';
import { listLaddersWithRungs, getLadderWithRungs } from '@/lib/ladder/ladder-service';
import { upsertLadderOutcome, listLadderOutcomes, fireStatusesByLadder } from '@/lib/ladder/ladder-outcome-service';
import { resolveLadderOutcome, buildExpectancyReport, DEFAULT_EXPECTANCY_BAR } from '@/lib/skills/ladder-expectancy-business-logic';
import { resolveArmRung } from '@/lib/ladder/ladder-arm-business-logic';
import { computeLadderRisk } from '@/lib/ladder/ladder-risk-business-logic';
import { fetchRecentFills, fetchClearinghouseState, type HlFill } from '@/lib/hyperliquid/hyperliquid-info-service';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';

const TERMINAL = new Set(['done', 'disarmed', 'expired']);
const fmtR = (r: number | null): string => (r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`);

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const reportOnly = args['report-only'] === true;
  const sessionId = typeof args['session'] === 'string' && args['session'].trim() ? args['session'] : null;
  const annotateId = typeof args['ladder'] === 'string' ? args['ladder'] : null;
  const signal = typeof args['signal'] === 'string' ? Number(args['signal']) : null;
  const timing = typeof args['timing'] === 'string' ? Number(args['timing']) : null;
  const now = Date.now();

  header('ladder-expectancy — outcome ledger + weekly review (advisory)');

  if (!reportOnly) {
    // ---- RESOLVE terminal ladders → outcome rows ----
    // The ledger must see BOTH sides of the soft-archive line: terminal ladders are
    // typically archived away from the cockpit list, but their outcomes are history.
    const [active, archived] = await Promise.all([
      listLaddersWithRungs(),
      listLaddersWithRungs(undefined, { archived: true }),
    ]);
    const all = [...active, ...archived];
    const terminal = all.filter((l) => TERMINAL.has(l.status));
    const existing = new Map((await listLadderOutcomes()).map((o) => [o.ladderId, o]));
    const toResolve = terminal.filter((l) => {
      const prev = existing.get(l.id);
      return !prev || prev.outcome === 'open'; // new, or re-resolve a still-open one
    });

    if (toResolve.length === 0) {
      line('No new terminal ladders to resolve.');
    } else {
      const address = getHlAccountAddress();
      let hlFills: HlFill[] | null = null;
      const openCoins = new Set<string>();
      if (address) {
        const oldest = Math.min(...toResolve.map((l) => Date.parse(l.armedAt ?? l.createdAt)));
        const fillsRes = await fetchRecentFills(address, Math.max(now - oldest + 3_600_000, 24 * 3_600_000), 2000);
        hlFills = fillsRes.error ? null : fillsRes.fills;
        try {
          const ch = await fetchClearinghouseState(address, { uncached: true });
          for (const p of ch.positions) if (p.size > 0) openCoins.add(p.coin.toUpperCase());
        } catch { /* unknown → treat coins as possibly open only if fills also missing */ }
      } else {
        line('(no HL_ACCOUNT_ADDRESS — only never_filled outcomes resolve fully)');
      }

      const fires = await fireStatusesByLadder(toResolve.map((l) => l.id));
      // Persisted thesis scores (review-ladder writes them; migration 0030) — priority:
      // explicit --ladder annotation > persisted-on-ladder > previously-recorded outcome.
      const thesisById = new Map<string, { s: number | null; t: number | null }>();
      try {
        const { getServiceRoleClient } = await import('@/lib/cockpit/supabase-server');
        const { data } = await getServiceRoleClient().from('ladders').select('id,signal_score,timing_score').in('id', toResolve.map((l) => l.id));
        for (const r of data ?? []) thesisById.set(r.id as string, { s: (r.signal_score as number | null) ?? null, t: (r.timing_score as number | null) ?? null });
      } catch { /* fail-soft */ }
      for (const l of toResolve) {
        const plannedRisk = computeLadderRisk(l.rungs.map(resolveArmRung), { maxTotalNotionalUsd: l.maxTotalNotionalUsd, maxTotalLossUsd: l.maxTotalLossUsd }).worstCaseLossWithFundingUsd;
        const coin = (l.rungs[0]?.coin ?? '').toUpperCase();
        const outcome = resolveLadderOutcome({
          ladder: l,
          fireStatuses: fires.get(l.id) ?? [],
          hlFills,
          plannedRiskUsd: plannedRisk,
          positionStillOpen: openCoins.has(coin),
          signalScore: annotateId && l.id.startsWith(annotateId) ? signal : (thesisById.get(l.id)?.s ?? existing.get(l.id)?.signalScore ?? null),
          timingScore: annotateId && l.id.startsWith(annotateId) ? timing : (thesisById.get(l.id)?.t ?? existing.get(l.id)?.timingScore ?? null),
          now,
        });
        await upsertLadderOutcome(outcome);
        line(`resolved ${l.id.slice(0, 8)} "${l.title.slice(0, 40)}" → ${outcome.outcome.toUpperCase()} ${fmtR(outcome.realizedR)} (planned $${plannedRisk.toFixed(0)})`);
      }
    }

    // Annotate-only path: attach thesis scores to an existing outcome (or a live ladder pre-resolve).
    if (annotateId && (signal != null || timing != null)) {
      const l = await getLadderWithRungs(annotateId).catch(() => null);
      if (l && !TERMINAL.has(l.status)) line(`(thesis scores noted for ${annotateId.slice(0, 8)} — they attach when it resolves)`);
    }
  }

  // ---- REPORT ----
  const outcomes = await listLadderOutcomes();
  if (outcomes.length === 0) { line('\nLedger empty — outcomes appear as ladders reach a terminal state.'); return; }

  const report = buildExpectancyReport(outcomes, DEFAULT_EXPECTANCY_BAR);
  header(`Expectancy report — ${report.totals.closedTrades} closed, net $${report.totals.totalPnlUsd}, expectancy ${fmtR(report.totals.expectancyR)}`);
  line(`(pre-registered bar: ${DEFAULT_EXPECTANCY_BAR.minTrades} closed trades min · kill ≤ ${DEFAULT_EXPECTANCY_BAR.killExpectancyR}R · size-up ≥ +${DEFAULT_EXPECTANCY_BAR.sizeUpExpectancyR}R)`);
  for (const s of report.perSetup) {
    line(`\n  ${s.setupType} — ${s.verdict}`);
    line(`    closed ${s.closedTrades} (W${s.wins}/L${s.losses}/S${s.scratches}) · never-filled ${s.neverFilled} · open ${s.open}`);
    line(`    winRate ${s.winRate == null ? '—' : `${(s.winRate * 100).toFixed(0)}%`} · avgWin ${fmtR(s.avgWinR)} · avgLoss ${fmtR(s.avgLossR)} · expectancy ${fmtR(s.expectancyR)} · net $${s.totalPnlUsd}`);
    line(`    ${s.reason}`);
  }

  if (sessionId) {
    const headline = report.perSetup.map((s) => `${s.setupType}: ${s.verdict} (${fmtR(s.expectancyR)}, n=${s.closedTrades})`).join(' · ');
    await writeAnalysisLog({ sessionId, source: 'ladder-expectancy', severity: report.perSetup.some((s) => s.verdict === 'KILL') ? 'warn' : 'info', message: `Expectancy review: ${headline}` }).catch(() => {});
  }
  line('\nAdvisory only. A SIZE-UP verdict earns ONE risk-tier step; a KILL means stop trading that setup.');
});
