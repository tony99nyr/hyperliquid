/**
 * pnpm tsx --tsconfig tsconfig.scripts.json scripts/review-all-traders.ts
 *
 * Rank the whole vetted pool by FOLLOWABILITY (the "what we're looking for" review):
 * joins persisted trader_evaluations with the rated-wallets metadata (name / vault /
 * composite) and applies the copyability gates. Separates "proven copyable" (real
 * round-trip evidence) from "no evidence" (0 closed trips → gates pass vacuously).
 * READ-ONLY.
 */
import { run, line } from './_skill-runtime';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { getRailTraders } from '@/lib/hyperliquid/top-traders-service';

type M = Record<string, number | string | null>;
function n(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

run(async () => {
  const c = getServiceRoleClient();
  const { data } = await c.from('trader_evaluations').select('*');
  const evals = (data ?? []) as Array<Record<string, unknown>>;

  const meta = new Map<string, { vault: boolean; composite: number | null }>();
  for (const t of getRailTraders(160)) {
    meta.set(t.address.toLowerCase(), { vault: t.allFlags.includes('VAULT_LED'), composite: t.composite });
  }

  const latest = new Map<string, Record<string, unknown>>();
  for (const e of evals) {
    const a = String(e.leader_address).toLowerCase();
    const prev = latest.get(a);
    if (!prev || String(e.generated_at) > String(prev.generated_at)) latest.set(a, e);
  }

  type Row = { addr: string; vault: boolean; verdict: string; adds: number|null; liq: number|null; worst: number|null; win: number|null; hold: number|null; trips: number|null; pnl: number|null; fills: number; gates: string[]; };
  const rows: Row[] = [];
  for (const [a, e] of latest) {
    const m = (e.metrics ?? {}) as M;
    const md = meta.get(a) ?? { vault: false, composite: null };
    const adds = n(m.addsPerTrip), liq = n(m.liquidations), worst = n(m.worstLossVsMedianWin);
    const win = n(m.winRate), hold = n(m.medianHoldHours), trips = n(m.roundTrips), pnl = n(m.realizedPnlUsd);
    const gates: string[] = [];
    if (e.verdict !== 'follow') gates.push(`verdict=${e.verdict}`);
    if (adds != null && adds > 3) gates.push(`adds/trip ${adds.toFixed(1)}`);
    if (liq != null && liq > 0) gates.push(`${liq} liq`);
    if (worst != null && worst > 6) gates.push(`worst/win ${worst.toFixed(1)}x`);
    if (hold != null && hold > 72) gates.push(`hold ${hold.toFixed(0)}h`);
    if (win != null && win < 0.4) gates.push(`win ${(win*100).toFixed(0)}%`);
    rows.push({ addr: a, vault: md.vault, verdict: String(e.verdict), adds, liq, worst, win, hold, trips, pnl, fills: Number(e.fills_seen ?? 0), gates });
  }

  const MIN_TRIPS = 5;
  const gateClean = rows.filter((r) => r.gates.length === 0);
  const proven = gateClean.filter((r) => (r.trips ?? 0) >= MIN_TRIPS);
  const thin = gateClean.filter((r) => (r.trips ?? 0) > 0 && (r.trips ?? 0) < MIN_TRIPS);
  const noEvidence = gateClean.filter((r) => (r.trips ?? 0) === 0);
  const flagged = rows.filter((r) => r.gates.length > 0);
  const byPnl = (x: Row, y: Row) => (Number(y.vault) - Number(x.vault)) || ((y.pnl ?? 0) - (x.pnl ?? 0));
  proven.sort(byPnl); thin.sort(byPnl);

  const fmtPnl = (v: number|null) => v == null ? '—' : (v >= 0 ? '+$' : '-$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const pct = (v: number|null) => v == null ? '—' : `${(v*100).toFixed(0)}%`;
  const fmtRow = (r: Row) => `   ${r.addr.slice(0,10)}…${r.addr.slice(-4)}  ${r.vault?'VAULT':'  -  '}  ${fmtPnl(r.pnl).padStart(11)}  ${pct(r.win).padStart(4)}  ${(r.hold!=null?r.hold.toFixed(0)+'h':'—').padStart(5)}  ${String(r.trips??'—').padStart(5)}  ${(r.adds!=null?r.adds.toFixed(1):'—').padStart(8)}  ${(r.worst!=null?r.worst.toFixed(1)+'x':'—').padStart(8)}`;

  line(`=== POOL REVIEW — ${rows.length} vetted traders ===`);
  line(`verdicts: follow ${rows.filter(r=>r.verdict==='follow').length} · caution ${rows.filter(r=>r.verdict==='caution').length} · avoid ${rows.filter(r=>r.verdict==='avoid').length}`);
  line('');
  const HDR = '   ADDRESS              VAULT      PnL(30d)   win   hold   trips  adds/trip  worst/win';
  line(`>>> PROVEN COPYABLE (${proven.length}) — verdict=follow, >=${MIN_TRIPS} closed round-trips, all gates clear:`);
  line(HDR);
  for (const r of proven) line(fmtRow(r));
  line('');
  line(`>>> THIN-BUT-CLEAN (${thin.length}) — clean, but only 1-${MIN_TRIPS-1} round-trips (low confidence):`);
  line(HDR);
  for (const r of thin) line(fmtRow(r));
  line('');
  line(`>>> NO ROUND-TRIP EVIDENCE (${noEvidence.length}) — verdict=follow but 0 closed trips`);
  line(`    (held through window, or window-edge/truncation — NOT proven copyable). Top 8 by PnL:`);
  for (const r of [...noEvidence].sort((a,b)=>(b.pnl??0)-(a.pnl??0)).slice(0,8)) line(`   ${r.addr.slice(0,10)}…${r.addr.slice(-4)}  ${r.vault?'[vault] ':''}PnL ${fmtPnl(r.pnl)}  (${r.fills} fills)`);
  line('');
  const close = flagged.filter(r => r.verdict === 'caution').sort((a,b)=>a.gates.length-b.gates.length).slice(0, 12);
  line(`>>> CAUTION TIER (top 12 by fewest flags):`);
  for (const r of close) line(`   ${r.addr.slice(0,10)}…${r.addr.slice(-4)} ${r.vault?'[vault] ':''}— ${r.gates.join(', ')}`);
});
