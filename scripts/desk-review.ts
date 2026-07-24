/**
 * skill:desk-review entrypoint (thin I/O). ADVISORY, READ-ONLY — it NEVER trades,
 * arms, or writes. One command assembles the whole desk picture so a review is
 * repeatable instead of a dozen ad-hoc queries:
 *
 *   THE BOOK      — live positions, armed ladders, draft ladders, open previews
 *   THE MARKET    — rubric opportunity board, per-coin short- vs long-term trend
 *                   (multi-TF regime), reversion-extreme candidates, funding/OI,
 *                   recent rated-leader flow, household cross-system stacking,
 *                   circuit-breaker state
 *
 * The SKILL (.claude/skills/desk-review/SKILL.md) runs this, then SYNTHESIZES it
 * with the desk discipline (stand-down by default, adversarial panel before any new
 * entry, household stacking, per-position hold/trim/exit). This script only gathers
 * + prints FACTS; the judgment is the skill's.
 *
 *   pnpm skill:desk-review [--coins BTC,ETH,SOL,HYPE] [--json]
 */

import { parseArgs, header, line, run } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import {
  fetchClearinghouseState,
  fetchAllMids,
  fetchMetaAndAssetCtxs,
  type HlAssetCtx,
} from '@/lib/hyperliquid/hyperliquid-info-service';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { listLaddersWithRungs } from '@/lib/ladder/ladder-service';
import { listOpenPreviews } from '@/lib/cockpit/pending-actions-service';
import {
  composeMarketAssessment,
  MARKET_TIMEFRAMES,
  type MarketTimeframe,
  type TimeframeCandles,
} from '@/lib/skills/analyze-market-business-logic';
import { scanReversionExtremes } from '@/lib/scout/reversion-scan-service';
import { readHouseholdExposure } from '@/lib/household/household-exposure-service';
import { checkCircuitBreaker } from '@/lib/risk/circuit-breaker-service';
import { splitTrend, opportunityFlag, trendLine, type OpportunityFlag } from '@/lib/skills/desk-review-business-logic';
import { validateEnv } from '@/lib/env/env';

const LOOKBACK_MS: Record<MarketTimeframe, number> = {
  '1d': 400 * 24 * 60 * 60 * 1000,
  '8h': 400 * 8 * 60 * 60 * 1000,
  '1h': 400 * 60 * 60 * 1000,
  '15m': 400 * 15 * 60 * 1000,
};

const uniq = (xs: string[]): string[] => [...new Set(xs)];
const pct = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;

interface RubricRead {
  coin: string;
  side: 'long' | 'short';
  opportunity: number;
  badge: string;
  target: number | null;
  invalidation: number | null;
}

/** Newest rubric row per (coin, side) from the last ~2h of scans. */
async function readRubricBoard(): Promise<{ reads: RubricRead[]; newestMs: number }> {
  const db = getServiceRoleClient();
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from('rubric_scores')
    .select('coin, side, opportunity, badge, target, invalidation, computed_at')
    .gte('computed_at', since)
    .order('computed_at', { ascending: false });
  const seen = new Set<string>();
  const reads: RubricRead[] = [];
  let newestMs = 0;
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const key = `${String(r.coin).toUpperCase()}:${r.side}`;
    const ms = Date.parse(String(r.computed_at));
    if (Number.isFinite(ms)) newestMs = Math.max(newestMs, ms);
    if (seen.has(key)) continue;
    seen.add(key);
    reads.push({
      coin: String(r.coin).toUpperCase(),
      side: r.side === 'short' ? 'short' : 'long',
      opportunity: Number(r.opportunity),
      badge: String(r.badge),
      target: r.target != null ? Number(r.target) : null,
      invalidation: r.invalidation != null ? Number(r.invalidation) : null,
    });
  }
  return { reads, newestMs };
}

/** Best (highest-opportunity) rubric read for a coin, either side. */
function bestRubric(reads: RubricRead[], coin: string): RubricRead | null {
  const forCoin = reads.filter((r) => r.coin === coin);
  if (forCoin.length === 0) return null;
  return forCoin.reduce((a, b) => (b.opportunity > a.opportunity ? b : a));
}

interface LeaderActionRow {
  coin: string;
  kind: string;
  newSide: string | null;
  notionalUsd: number;
  leader: string;
  atMs: number;
}

async function readRecentLeaderActions(): Promise<LeaderActionRow[]> {
  const db = getServiceRoleClient();
  const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from('leader_actions')
    .select('coin, kind, new_side, notional_usd, leader_address, detected_at')
    .in('kind', ['open', 'add', 'flip'])
    .gte('detected_at', since)
    .order('detected_at', { ascending: false })
    .limit(10);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    coin: String(r.coin).toUpperCase(),
    kind: String(r.kind),
    newSide: r.new_side ? String(r.new_side) : null,
    notionalUsd: Number(r.notional_usd) || 0,
    leader: String(r.leader_address).slice(0, 10),
    atMs: Date.parse(String(r.detected_at)) || 0,
  }));
}

run(async () => {
  const args = parseArgs(process.argv.slice(2));
  const jsonOut = args['json'] === true || args['json'] === 'true';
  const network = validateEnv().HL_NETWORK;
  const now = Date.now();

  header('desk-review — full book + market read (ADVISORY, read-only)');

  // ===== gather THE BOOK + market context in parallel =====
  const addr = getHlAccountAddress();
  const [ch, ladders, previews, mids, ctxs] = await Promise.all([
    addr ? fetchClearinghouseState(addr).catch(() => null) : Promise.resolve(null),
    listLaddersWithRungs().catch(() => []),
    listOpenPreviews().catch(() => []),
    fetchAllMids(network).catch(() => ({}) as Record<string, number>),
    fetchMetaAndAssetCtxs(network).catch(() => ({}) as Record<string, HlAssetCtx>),
  ]);
  const positions = (ch?.positions ?? []).filter((p) => p.size > 0);
  const armed = ladders.filter((l) => l.status === 'armed');
  const drafts = ladders.filter((l) => l.status === 'draft');

  // Coin universe: what we hold / have queued + the majors.
  const coins = uniq(
    [
      ...positions.map((p) => p.coin),
      ...armed.flatMap((l) => l.rungs.map((r) => r.coin)),
      ...drafts.flatMap((l) => l.rungs.map((r) => r.coin)),
      ...previews.map((p) => p.proposal.intent.coin),
      'BTC',
      'ETH',
      'SOL',
      'HYPE',
    ].map((c) => c.toUpperCase()),
  ).slice(0, 8);

  // ===== gather MARKET analytics =====
  const [{ reads: rubric, newestMs: rubricMs }, reversion, leaders, household, breaker] = await Promise.all([
    readRubricBoard().catch(() => ({ reads: [] as RubricRead[], newestMs: 0 })),
    scanReversionExtremes(coins, now).catch(() => ({ hits: [], regimeByCoin: {}, coverage: { requested: 0, scanned: 0, skipped: 0 } })),
    readRecentLeaderActions().catch(() => [] as LeaderActionRow[]),
    readHouseholdExposure({ ethUsd: Number(mids['ETH']) || 0, btcUsd: Number(mids['BTC']) || 0 }).catch(() => null),
    checkCircuitBreaker('scout', now).catch(() => null),
  ]);
  const revByCoin = new Map(reversion.hits.map((h) => [h.coin.toUpperCase(), h]));

  // Per-coin multi-TF regime (fail-soft per coin).
  const trendByCoin = new Map<string, ReturnType<typeof splitTrend> & { biasLabel: string }>();
  await Promise.all(
    coins.map(async (coin) => {
      try {
        const candles: TimeframeCandles = {};
        await Promise.all(
          MARKET_TIMEFRAMES.map(async (tf) => {
            const res = await fetchCandles(coin, tf, now - LOOKBACK_MS[tf], now).catch(() => null);
            if (res && !res.stale && res.candles.length > 0) candles[tf] = res.candles;
          }),
        );
        const a = composeMarketAssessment(coin, candles);
        trendByCoin.set(coin, { ...splitTrend(a.reads), biasLabel: a.biasLabel });
      } catch {
        /* per-coin fail-soft — coin just shows no trend read */
      }
    }),
  );

  // ===================== PRINT: THE BOOK =====================
  header('THE BOOK');
  if (positions.length === 0) line('Live positions: none (flat).');
  else {
    line('Live positions:');
    for (const p of positions) {
      const roe = p.returnOnEquity != null ? ` roe=${pct(p.returnOnEquity * 100)}` : '';
      const liq = p.liquidationPx != null ? ` liq=${p.liquidationPx}` : '';
      line(`  ${p.side.toUpperCase()} ${p.size} ${p.coin} @ ${p.entryPx ?? '?'}  uPnL=$${p.unrealizedPnl.toFixed(2)}${roe}  lev=${p.leverage ?? '?'}${liq}`);
    }
  }
  line(`Armed ladders: ${armed.length}${armed.length ? '' : ' (none live)'}`);
  for (const l of armed) line(`  ⚡ ${l.title} [${l.mode}] ${l.id.slice(0, 8)} — ${uniq(l.rungs.map((r) => r.coin)).join(',')} · ${l.rungs.length} rungs${l.expiresAt ? ` · exp ${l.expiresAt.slice(0, 16)}` : ''}`);
  line(`Draft ladders: ${drafts.length}${drafts.length ? '' : ' (none)'}`);
  for (const l of drafts) line(`  ✎ ${l.title} ${l.id.slice(0, 8)} — ${uniq(l.rungs.map((r) => r.coin)).join(',')} · ${l.rungs.length} rungs`);
  line(`Open previews (position drafts): ${previews.length}${previews.length ? '' : ' (none)'}`);
  for (const pv of previews) {
    const it = pv.proposal.intent;
    line(`  ▷ ${it.side?.toUpperCase?.() ?? '?'} ${it.coin} sz=${it.sz ?? '?'}${pv.review ? ` · reviewed: ${pv.review.verdict}` : ' · UNREVIEWED'}`);
  }

  // ===================== PRINT: THE MARKET =====================
  header('THE MARKET — per-coin read (short- vs long-term trend, rubric, reversion, carry)');
  line('coin   mark        24h      trend                              opp       rubric(best)     reversion   funding');
  const rows: Array<Record<string, unknown>> = [];
  for (const coin of coins) {
    const mark = Number(mids[coin]);
    const ctx = ctxs[coin];
    const chg = ctx && ctx.prevDayPx > 0 && Number.isFinite(mark) ? ((mark - ctx.prevDayPx) / ctx.prevDayPx) * 100 : null;
    const t = trendByCoin.get(coin);
    const rb = bestRubric(rubric, coin);
    const rev = revByCoin.get(coin) ?? null;
    const flag: OpportunityFlag = opportunityFlag({
      rubricBest: rb ? { side: rb.side, opportunity: rb.opportunity, badge: rb.badge } : null,
      reversion: rev ? { side: rev.side, z: rev.z } : null,
    });
    const fundingApr = ctx ? ctx.fundingHourly * 24 * 365 * 100 : null;
    const trendStr = t ? trendLine(t) : 'no data';
    const rubricStr = rb ? `${rb.side} ${Math.round(rb.opportunity)} ${rb.badge}` : '—';
    const revStr = rev ? `${rev.side} z=${rev.z.toFixed(1)}` : '—';
    line(
      `${coin.padEnd(6)} ${String(Number.isFinite(mark) ? mark : '?').padEnd(11)} ${String(chg != null ? pct(chg) : '?').padEnd(8)} ${trendStr.padEnd(34)} ${flag.padEnd(9)} ${rubricStr.padEnd(16)} ${revStr.padEnd(11)} ${fundingApr != null ? pct(fundingApr) + ' APR' : '?'}`,
    );
    rows.push({ coin, mark, chg24hPct: chg, trend: t ?? null, opportunity: flag, rubricBest: rb, reversion: rev, fundingApr, openInterest: ctx?.openInterest ?? null });
  }
  line('');
  line('opp: GO = rubric edge cleared the bar · REVERSION = a backtested fade candidate · WATCH = rubric building · NONE = stand down');
  const rubricAgeMin = rubricMs > 0 ? Math.round((now - rubricMs) / 60000) : null;
  line(`rubric freshness: ${rubricAgeMin == null ? 'NO recent scan (run pnpm rubric)' : rubricAgeMin + 'm old'}${rubricAgeMin != null && rubricAgeMin > 20 ? ' ⚠ STALE' : ''}`);
  if (reversion.coverage.skipped > 0) line(`reversion scan: ${reversion.coverage.scanned}/${reversion.coverage.requested} coins evaluated, ${reversion.coverage.skipped} skipped`);

  // ===================== PRINT: SIGNALS =====================
  header('SIGNALS');
  if (leaders.length === 0) line('Rated-leader flow (12h): none.');
  else {
    line('Rated-leader flow (12h, open/add/flip ≥ materiality):');
    for (const a of leaders) line(`  ${Math.round((now - a.atMs) / 60000)}m ago  ${a.kind.toUpperCase()} ${a.newSide ?? ''} ${a.coin} $${(a.notionalUsd / 1e6).toFixed(2)}M  (${a.leader})`);
  }
  if (household) {
    line(`Household (iamrossi on-chain): ETH $${Math.round(household.ethExposureUsd)} · BTC $${Math.round(household.btcExposureUsd)} · net crypto beta $${Math.round(household.netCryptoBetaUsd)} (dominant ${household.dominant}). A cockpit long on the dominant leg STACKS; a short partially hedges.`);
  } else {
    line('Household exposure: unconfigured (IAMROSSI_SAFE_ETH/BTC unset) or read failed.');
  }
  if (breaker) {
    line(`Circuit breaker (scout paper equity $${breaker.equityUsd.toFixed(0)}): ${breaker.blockNewEntries ? `⛔ HALTED — ${breaker.reason}` : `✓ ${breaker.reason}`}`);
  }

  header('Synthesis is the SKILL\'s job');
  line('This is FACTS only. See .claude/skills/desk-review/SKILL.md for the read: stand-down by default,');
  line('adversarial panel before any new entry, household stacking, per-position hold/trim/exit.');

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          at: new Date(now).toISOString(),
          book: {
            positions: positions.map((p) => ({ coin: p.coin, side: p.side, size: p.size, entryPx: p.entryPx, unrealizedPnl: p.unrealizedPnl, leverage: p.leverage, liquidationPx: p.liquidationPx })),
            armedLadders: armed.map((l) => ({ id: l.id, title: l.title, mode: l.mode, coins: uniq(l.rungs.map((r) => r.coin)), rungCount: l.rungs.length, expiresAt: l.expiresAt })),
            draftLadders: drafts.map((l) => ({ id: l.id, title: l.title, coins: uniq(l.rungs.map((r) => r.coin)), rungCount: l.rungs.length })),
            previews: previews.map((pv) => ({ coin: pv.proposal.intent.coin, side: pv.proposal.intent.side, reviewed: pv.review?.verdict ?? null })),
          },
          market: rows,
          signals: { leaders, household, breaker: breaker ? { halted: breaker.blockNewEntries, reason: breaker.reason, equityUsd: breaker.equityUsd } : null },
          rubricAgeMin,
        },
        null,
        2,
      ),
    );
  }
});
