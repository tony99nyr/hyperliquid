/**
 * skill:review-ladder entrypoint (thin I/O). ADVISORY ONLY — never arms or trades.
 *
 * Runs the PURE "pro-desk" critical scorecard (reviewLadder) over one ladder (--ladder
 * <id>) or every ARMED + DRAFT ladder (default). Fetches live mids + funding (read-only),
 * scores RISK and UPSIDE pillars 0/10, and prints a verdict + any hard blockers. The two
 * judgment pillars (thesis/signal, timing) can be supplied with --signal / --timing (0-10)
 * after an analyze-market / analyze-traders read; otherwise they score neutral + flag the
 * owed read.
 *
 * Usage:
 *   pnpm skill:review-ladder [--ladder <id>] [--equity 980] [--signal 6] [--timing 7] [--session <id>]
 */

import { parseArgs, optionalNumber, header, line, run } from './_skill-runtime';
import { listLaddersWithRungs, getLadderWithRungs } from '@/lib/ladder/ladder-service';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { reviewLadder, rubricSignalScore, type LadderReviewScorecard } from '@/lib/skills/review-ladder-business-logic';
import { fetchAllMids, fetchMetaAndAssetCtxs } from '@/lib/hyperliquid/hyperliquid-info-service';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { validateEnv } from '@/lib/env/env';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import type { LadderWithRungs } from '@/lib/ladder/ladder-types';

const bar = (score: number): string => '█'.repeat(Math.round(score)) + '░'.repeat(10 - Math.round(score));

function printScorecard(sc: LadderReviewScorecard): void {
  header(`${sc.title}  [${sc.mode}/${sc.status}]  ${sc.ladderId.slice(0, 8)}`);
  line(`VERDICT: ${sc.verdict}`);
  line(`RISK ${sc.riskScore}/10   UPSIDE ${sc.upsideScore}/10`);
  line(`worst case (slip+funding): $${sc.worstCaseLossWithFundingUsd}  ·  notional $${sc.totalNotionalUsd}${sc.pctOfEquity != null ? `  ·  ${sc.pctOfEquity}% of equity` : ''}`);
  if (sc.blockers.length) { line('\n  ⛔ BLOCKERS:'); for (const b of sc.blockers) line(`     - ${b}`); }
  line('\n  RISK pillars (0/10, higher = safer):');
  for (const p of sc.riskPillars) line(`     ${bar(p.score)} ${p.score}/10  ${p.label} · ${p.lens}\n        ${p.note}`);
  line('\n  UPSIDE pillars (0/10, higher = better):');
  for (const p of sc.upsidePillars) line(`     ${bar(p.score)} ${p.score}/10  ${p.label} · ${p.lens}\n        ${p.note}`);
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const network = validateEnv().HL_NETWORK;
  const onlyId = typeof args['ladder'] === 'string' ? args['ladder'] : null;
  const equity = optionalNumber(args, 'equity', NaN);
  const signal = typeof args['signal'] === 'string' ? Number(args['signal']) : null;
  const timing = typeof args['timing'] === 'string' ? Number(args['timing']) : null;
  const sessionId = typeof args['session'] === 'string' && args['session'].trim() ? args['session'] : null;
  const now = Date.now();

  header('review-ladder — pro-desk critical scorecard (advisory)');
  let ladders: LadderWithRungs[];
  if (onlyId) {
    const l = await getLadderWithRungs(onlyId);
    if (!l) { line(`No ladder ${onlyId}.`); return; }
    ladders = [l];
  } else {
    const all = await listLaddersWithRungs();
    ladders = all.filter((l) => l.status === 'armed' || l.status === 'draft');
  }
  if (ladders.length === 0) { line('No armed or draft ladders to review.'); return; }

  const coins = Array.from(new Set(ladders.flatMap((l) => l.rungs.map((r) => r.coin.toUpperCase()))));
  const mids = await fetchAllMids(network, { uncached: true });
  let fundingByCoin: Record<string, number | null> = {};
  try {
    const ctxs = await fetchMetaAndAssetCtxs(network);
    fundingByCoin = Object.fromEntries(coins.map((c) => [c, ctxs[c]?.fundingHourly ?? null]));
  } catch { fundingByCoin = {}; }
  const midByCoin = Object.fromEntries(coins.map((c) => [c, Number.isFinite(mids[c]) ? mids[c] : null]));
  const accountEquityUsd = Number.isFinite(equity) ? equity : null;

  // Salient recent wick extremes per (coin, ladder side) — the 3 deepest stop-side wicks of
  // the last ~48h of 1h candles — for the stop-hygiene check. Fail-soft: no candles → the
  // hygiene check degrades to round-number-only.
  const recentWicksByCoin: Record<string, number[] | null> = {};
  for (const l of ladders) {
    const coin = (l.rungs[0]?.coin ?? '').toUpperCase();
    if (!coin || coin in recentWicksByCoin) continue;
    const side = l.rungs.find((r) => r.action === 'open')?.side ?? 'long';
    try {
      const res = await fetchCandles(coin, '1h', now - 48 * 3_600_000, now);
      const candles = res.candles ?? [];
      recentWicksByCoin[coin] = side === 'long'
        ? candles.map((c) => c.low).sort((a, b) => a - b).slice(0, 3)
        : candles.map((c) => c.high).sort((a, b) => b - a).slice(0, 3);
    } catch { recentWicksByCoin[coin] = null; }
  }

  // LIVE resting stops for coins whose entry rung has FIRED — the real exchange order
  // supersedes the arm-time projection (the fire path derives the stop off the FILL, and
  // the operator may have tightened it since; scoring the projection produced false magnet
  // flags). Read via the cockpit stops endpoint (the signing deployment). Semantics for the
  // pure layer: number = live stop; null = read OK but NO stop (naked — blocker); key
  // absent = unreadable → projection fallback. Fail-soft on any error.
  const liveStopByCoin: Record<string, number | null> = {};
  const firedCoins = new Set(
    ladders.flatMap((l) => l.rungs.filter((r) => (r.action === 'open' || r.action === 'add') && r.status === 'fired').map((r) => r.coin.toUpperCase())),
  );
  if (firedCoins.size > 0) {
    const base = process.env.COCKPIT_BASE_URL ?? 'https://hyperliquid-rouge.vercel.app';
    const adminSecret = process.env.ADMIN_SECRET;
    if (adminSecret) {
      for (const coin of firedCoins) {
        try {
          const res = await fetch(`${base}/api/cockpit/position-stop?coin=${coin}`, { headers: { Authorization: `Bearer ${adminSecret}` }, signal: AbortSignal.timeout(8000) });
          if (!res.ok) continue; // unreadable → projection fallback
          const j = (await res.json()) as { ok?: boolean; stop?: { triggerPx?: number } | null };
          if (j.ok === false) continue;
          liveStopByCoin[coin] = j.stop?.triggerPx != null && j.stop.triggerPx > 0 ? j.stop.triggerPx : null;
        } catch { /* unreadable → projection fallback */ }
      }
    } else {
      line('(fired rung(s) present but no ADMIN_SECRET — stop pillar uses the arm-time projection)');
    }
  }

  // Auto-signal from the rubric (ADR-0006) when the operator didn't hand-score: the
  // freshest rubric_scores row per (coin, side), ≤24h old, mapped 0-100 → 0-10. A
  // kill-gated rubric is a hard 0 (the rubric says NO TRADE). Fail-soft: no row/stale/
  // fetch error → null → the pillar renders neutral + "owed" exactly as before.
  const rubricSignalByLadder = new Map<string, number | null>();
  const rubricReasonByLadder = new Map<string, string>();
  if (signal == null) {
    try {
      const db = getServiceRoleClient();
      for (const l of ladders) {
        const coin = (l.rungs[0]?.coin ?? '').toUpperCase();
        const side = l.rungs.find((r) => r.action === 'open')?.side ?? l.rungs[0]?.side ?? 'long';
        const { data } = await db
          .from('rubric_scores')
          .select('opportunity,computed_at,no_trade_reason')
          .eq('coin', coin).eq('side', side)
          .order('computed_at', { ascending: false }).limit(1);
        const row = data?.[0];
        const score = row
          ? rubricSignalScore(row.opportunity as number, Date.parse(row.computed_at as string), now, (row.no_trade_reason as string | null) ?? null)
          : null;
        rubricSignalByLadder.set(l.id, score);
        if (score != null && row?.no_trade_reason) rubricReasonByLadder.set(l.id, row.no_trade_reason as string);
      }
    } catch { /* fail-soft — pillar falls back to neutral+owed */ }
  }
  const ctxFor = (l: LadderWithRungs) => {
    const auto = signal == null ? (rubricSignalByLadder.get(l.id) ?? null) : null;
    const reason = rubricReasonByLadder.get(l.id);
    return {
      midByCoin, fundingByCoin, accountEquityUsd, recentWicksByCoin, liveStopByCoin, now,
      signalScore: signal ?? auto,
      timingScore: timing,
      signalSource: signal != null ? 'operator' : auto != null ? `rubric ADR-0006, auto${reason ? ` — ${reason}` : ''}` : null,
    };
  };
  // First pass for book heat. An OCO group is ONE position (one leg fires → the sibling
  // auto-disarms), so a group contributes only its WORST leg — else a straddle double-counts.
  const first = ladders.map((l) => reviewLadder(l, { ...ctxFor(l), otherLaddersWorstCaseUsd: null }));
  const wcById = new Map(first.map((s) => [s.ladderId, s.worstCaseLossWithFundingUsd]));
  const groupWc = new Map<string, number>();
  for (const l of ladders) {
    const key = l.ocoGroupId ?? `solo:${l.id}`;
    groupWc.set(key, Math.max(groupWc.get(key) ?? 0, wcById.get(l.id) ?? 0));
  }
  const bookHeat = [...groupWc.values()].reduce((a, b) => a + b, 0);

  line(`${ladders.length} ladder(s) · book heat $${bookHeat.toFixed(0)} (OCO groups counted once)${accountEquityUsd ? ` = ${((bookHeat / accountEquityUsd) * 100).toFixed(1)}% of equity` : ''}`);

  for (const l of ladders) {
    const others = bookHeat - (wcById.get(l.id) ?? 0);
    const sc = ladders.length > 1 ? reviewLadder(l, { ...ctxFor(l), otherLaddersWorstCaseUsd: others }) : first[0];
    printScorecard(sc);
    if (sessionId) {
      await writeAnalysisLog({
        sessionId,
        source: 'review-ladder',
        severity: sc.blockers.length ? 'danger' : sc.riskScore < 5 ? 'warn' : 'info',
        message: `Ladder ${sc.ladderId.slice(0, 8)} "${sc.title}": RISK ${sc.riskScore}/10, UPSIDE ${sc.upsideScore}/10 — ${sc.verdict}`,
      }).catch(() => {});
    }
  }
  line('\nAdvisory only. Reviewing a ladder never arms it — the operator arms in the cockpit (typed phrase).');
});
