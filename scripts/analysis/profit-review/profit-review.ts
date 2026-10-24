/**
 * Profit-review evidence bundle (docs/PROFIT_REVIEW_2026-10-24.md, item 0).
 * STRICTLY READ-ONLY: HL info API (POST /info) and Supabase REST GETs only. Never trades,
 * arms, or writes a row. Never prints secrets or the account address.
 *
 * Usage:
 *   pnpm analysis:profit-review                    # JSON to stdout
 *   pnpm analysis:profit-review --out bundle.json [--md summary.md]   # JSON to file, markdown to stdout
 *   flags: --since 2026-08-01 (split-out window for the "since" block, default 2026-08-01)
 */
import { writeFileSync } from 'node:fs';
import {
  buildRoundTrips, attributeTrips, summarise, groupStats, monthKey, reconcile, straddleReport,
  scoutLaneStats, removeLargestCluster,
  type HlFillRow, type FundingRow, type FireRow, type RungRow, type OutcomeRow, type HypRow,
} from '@/lib/backtest/profit-review-business-logic';

try { process.loadEnvFile('.env.local'); } catch { /* env may already be set */ }

const HL = 'https://api.hyperliquid.xyz/info';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function hl<T>(body: object): Promise<T> {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return (await res.json()) as T;
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw new Error(`HL info ${(body as { type: string }).type} failed`);
}

/** Pages userFillsByTime (2000 per page) from the beginning of time, de-duplicated by tid. */
async function allFills(user: string): Promise<HlFillRow[]> {
  const seen = new Map<number, HlFillRow>();
  let start = 0;
  for (let page = 0; page < 50; page++) {
    const rows = await hl<HlFillRow[]>({ type: 'userFillsByTime', user, startTime: start, aggregateByTime: false });
    const before = seen.size;
    for (const r of rows) seen.set(r.tid ?? Number(`${r.time}${seen.size}`), r);
    if (rows.length < 2000 || seen.size === before) break;
    start = rows[rows.length - 1].time;
  }
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

async function allFunding(user: string): Promise<FundingRow[]> {
  const out: FundingRow[] = [];
  let start = 0;
  for (let page = 0; page < 50; page++) {
    const rows = await hl<FundingRow[]>({ type: 'userFunding', user, startTime: start });
    if (!rows.length) break;
    out.push(...rows);
    start = rows[rows.length - 1].time + 1;
    if (rows.length < 500) break;
  }
  return out;
}

const SB_URL = process.env.HL_TRADERS_SUPABASE_URL ?? '';
const SB_KEY = process.env.HL_TRADERS_SUPABASE_SERVICE_ROLE_KEY ?? process.env.HL_TRADERS_SUPABASE_SECRET_KEY ?? '';

/** Paged GET select. Read-only by construction: the only verb used is GET. */
async function select<T>(table: string, query = ''): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += 1000) {
    const res = await fetch(`${SB_URL}/rest/v1/${table}?select=*${query}`, {
      method: 'GET',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Range: `${off}-${off + 999}` },
    });
    if (!res.ok) throw new Error(`select ${table} failed: ${res.status}`);
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const f2 = (n: number): string => n.toFixed(2);
const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

async function buildBundle() {
  const user = process.env.HL_ACCOUNT_ADDRESS;
  if (!user || !SB_URL || !SB_KEY) throw new Error('Missing HL_ACCOUNT_ADDRESS or Supabase env (.env.local)');
  const sinceIso = arg('since') ?? '2026-08-01';
  const since = Date.parse(sinceIso);

  const [fills, funding, rungs, fires, outcomes, hyps] = await Promise.all([
    allFills(user), allFunding(user),
    select<RungRow>('ladder_rungs'), select<FireRow>('ladder_fires'), select<OutcomeRow>('ladder_outcomes'),
    select<HypRow & { setup_type: string | null }>('hypotheses', '&lane=not.is.null&order=created_at'),
  ]);

  const { trips, open, excludedFills } = buildRoundTrips(fills, funding);
  attributeTrips(trips, fires, rungs, outcomes);
  const recon = reconcile(trips, outcomes, fills);
  const straddles = straddleReport(outcomes, rungs, fires);
  const lanes = scoutLaneStats(hyps);
  const htf = removeLargestCluster(hyps.filter((h) => h.lane === 'htf-trend'), 5);
  const sinceTrips = trips.filter((t) => t.t0 >= since);

  const bundle = {
    generatedAt: new Date().toISOString(),
    inputs: { fills: fills.length, perpFillsExcludedAsSpot: excludedFills, funding: funding.length, rungs: rungs.length, fires: fires.length, outcomes: outcomes.length, hypotheses: hyps.length },
    firstFill: fills[0] ? new Date(fills[0].time).toISOString() : null,
    openPositions: open,
    inheritedTrips: trips.filter((t) => t.inherited).length,
    liveRoundTrips: {
      since: sinceIso,
      lifetime: summarise(trips),
      sinceWindow: summarise(sinceTrips),
      monthly: groupStats(trips, monthKey),
      perSetup: groupStats(trips, (t) => t.setup),
      perSetupSince: groupStats(sinceTrips, (t) => t.setup),
      holdBuckets: groupStats(trips, (t) => (t.hours < 6 ? '<6h' : t.hours < 72 ? '6-72h' : '>=72h')),
      trips: trips.map((t) => ({ ...t, t0: new Date(t.t0).toISOString(), t1: new Date(t.t1).toISOString() })),
    },
    reconciliation: recon,
    eventStraddles: straddles,
    scout: { lanes, htfTrendLargest5dClusterRemoved: htf },
  };

  return bundle;
}

type Bundle = Awaited<ReturnType<typeof buildBundle>>;

async function main(): Promise<void> {
  const bundle = await buildBundle();
  const md = renderMarkdown(bundle);
  const out = arg('out');
  const mdPath = arg('md');
  if (mdPath) writeFileSync(mdPath, md);
  if (out) { writeFileSync(out, JSON.stringify(bundle, null, 2)); process.stdout.write(md); }
  else process.stdout.write(JSON.stringify(bundle, null, 2) + '\n');
}

function renderMarkdown(b: Bundle): string {
  const L: string[] = [`# Profit review evidence bundle (${b.generatedAt})`, ''];
  const row = (k: string, s: ReturnType<typeof summarise>): string =>
    `| ${k} | ${s.n} | ${pct(s.winRate)} | ${f2(s.avgWin)} / ${f2(s.avgLoss)} | ${f2(s.payoff)} | ${f2(s.expectancy)} | ${f2(s.net)} | ${f2(s.fees)} | ${f2(s.funding)} |`;
  const head = '| key | n | win | avg win / loss | payoff | expectancy | net $ | fees | funding |\n|---|---|---|---|---|---|---|---|---|';
  L.push('## 1. Live round trips (flat-to-flat, net of fees and funding)', '', head);
  L.push(row('lifetime', b.liveRoundTrips.lifetime), row(`since ${b.liveRoundTrips.since}`, b.liveRoundTrips.sinceWindow));
  for (const [k, s] of Object.entries(b.liveRoundTrips.monthly)) L.push(row(k, s));
  L.push('', 'Per setup (fill reconstruction):', '', head);
  for (const [k, s] of Object.entries(b.liveRoundTrips.perSetup)) L.push(row(k, s));
  L.push('', `Trips that start mid-position (truncated history): ${b.inheritedTrips}`, '');
  L.push('## 2. Reconciliation vs ladder_outcomes', '', '| setup | fills n | fills net | fills net ex funding | outcomes closed n | outcomes net | outcomes mean R | delta |', '|---|---|---|---|---|---|---|---|');
  for (const r of b.reconciliation.bySetup) L.push(`| ${r.setup} | ${r.fillsN} | ${f2(r.fillsNet)} | ${f2(r.fillsNetExFunding)} | ${r.outcomesClosedN} | ${f2(r.outcomesNet)} | ${r.outcomesMeanR == null ? 'n/a' : f2(r.outcomesMeanR)} | ${f2(r.delta)} |`);
  L.push('', `Mismatches (${b.reconciliation.mismatches.length}):`, '');
  for (const m of b.reconciliation.mismatches) L.push(`- ${m.ladderId.slice(0, 8)} ${m.title.slice(0, 60)} [${m.setup}] outcome ${f2(m.outcomeNet)} vs trips ${m.tripNetExFunding == null ? 'none' : f2(m.tripNetExFunding)}: ${m.reason}`);
  L.push('', '## 3. Event straddles', '', `Fired: ${b.eventStraddles.fired} (of which titled "event template": ${b.eventStraddles.firedTemplateOnly}); never_filled: ${b.eventStraddles.neverFilled}. FIRED means the leg has an open rung with a ladder_fires row whose status is 'filled'; each leg counts once.`, '', '| ladder | outcome | planned risk (slip-aware) | nominal risk | net $ | slip-aware R | nominal R |', '|---|---|---|---|---|---|---|');
  for (const r of b.eventStraddles.rows.filter((x) => x.fired)) L.push(`| ${r.title.slice(0, 55)} | ${r.outcome} | ${r.plannedRiskSlipAware == null ? '' : f2(r.plannedRiskSlipAware)} | ${r.nominalRisk == null ? '' : f2(r.nominalRisk)} | ${f2(r.net)} | ${r.slipAwareR == null ? '' : f2(r.slipAwareR)} | ${r.nominalR == null ? '' : f2(r.nominalR)} |`);
  L.push('', '## 4. Scout lanes (closed hypotheses)', '', '| lane | n | win | mean R | sum R | net $ |', '|---|---|---|---|---|---|');
  for (const l of b.scout.lanes) L.push(`| ${l.lane} | ${l.n} | ${pct(l.winRate)} | ${f2(l.meanR)} | ${f2(l.sumR)} | ${f2(l.netUsd)} |`);
  const h = b.scout.htfTrendLargest5dClusterRemoved;
  L.push('', `htf-trend: n=${h.before.n}, mean ${f2(h.before.meanR)}R, sum ${f2(h.before.sumR)}R. Largest 5-day cluster (from ${h.windowStart}) removed ${h.removed} closes: n=${h.after.n}, mean ${f2(h.after.meanR)}R, sum ${f2(h.after.sumR)}R, net $${f2(h.after.netUsd)}.`, '');
  return L.join('\n');
}

main().catch((e: unknown) => {
  process.stderr.write(`profit-review failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
