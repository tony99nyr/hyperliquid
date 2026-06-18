/**
 * Fill the report template placeholders from the result JSONs. Reads the report,
 * substitutes {TOKENS}, writes it back. Idempotent-ish (only replaces remaining tokens).
 */
import * as fs from 'fs';
import { PATHS } from './study-config';

const REPORT = '/home/tony/gitrepos/iamrossi/docs/trading/PERP_FOLLOW_STUDY_2026-06.md';
const pct = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const num = (x: number | null | undefined, d = 3) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));

function j(p: string) { return JSON.parse(fs.readFileSync(`${PATHS.OUT_DIR}/${p}`, 'utf8')); }

const disc = j('discovered-addresses.json');
const A = j('partA-results.json');
const B = j('partB-results.json');
const C = j('comparison-results.json');
const pooled = B.pooledForwardEntry;

const repl: Record<string, string> = {};
// discovery
repl['DISC_BLOCKS'] = String(disc.meta.inWindowBlocks);
repl['DISC_ADDRS'] = String(disc.meta.distinctAddrs);
// part A descriptive
repl['A_ACTIVE'] = String(A.meta.activeCount);
repl['A_TOTAL'] = String(A.meta.totalProfiles);
repl['A_WR_MED'] = pct(A.descriptive.winRate.median);
repl['A_WR_P90'] = pct(A.descriptive.winRate.p90);
repl['A_NTRIPS'] = String(Math.round(A.descriptive.nTrips.median));
repl['A_PF'] = num(A.descriptive.profitFactor.median, 2);
repl['A_SHARPE'] = num(A.descriptive.perTradeSharpe.median);
repl['A_CALMAR'] = num(A.descriptive.calmar.median, 2);
repl['A_MAXDD'] = num(A.descriptive.maxDrawdownFrac.median, 2);
repl['A_BLOWUP'] = pct(A.descriptive.blowUpRate);
// win-rate trap
const wt = A.winRateTrap.topDecileWinRate;
repl['WT_N'] = String(wt.n);
repl['WT_BLOWUP'] = pct(wt.blowUpRate);
repl['WT_PF'] = num(wt.medianProfitFactor, 2);
repl['WT_WL'] = num(wt.medianWinLossRatio, 2);
repl['WT_MAXDD'] = num(wt.medianMaxDD, 2);
repl['WINRATE_TRAP_PROSE'] = `Among the top decile by trailing-60d win rate (n=${wt.n}), the blow-up rate is ${pct(wt.blowUpRate)}, median profit factor ${num(wt.medianProfitFactor, 2)}, and median avg-win/avg-loss ratio ${num(wt.medianWinLossRatio, 2)} — they win small and lose big.`;
// persistence
const pw = A.persistence.winRate, pp = A.persistence.pnlRet;
repl['PERSISTENCE_PROSE'] = `Win-rate persistence (window N → N+1) on the active off-leaderboard set: pooled Spearman IC ${num(pw.pooledIC)} (${pw.nPairs} pairs${pw.ci && Number.isFinite(pw.ci.lo) ? `, 95% CI [${num(pw.ci.lo)}, ${num(pw.ci.hi)}]` : ''}); top-quintile P(top→top) ${num(pw.topQuintile?.pTopTop, 2)} vs P(top→bottom) ${num(pw.topQuintile?.pTopBot, 2)}; forward positive-PnL fraction of top-quintile ${num(pw.fwdPnlTopPositive, 2)}. PnL-return persistence pooled IC ${num(pp.pooledIC)} (${pp.nPairs} pairs). ${pw.nPairs < 30 ? '**Power is low** — the ~12k-fill retention cap means few off-leaderboard wallets have ≥5 round-trips in two adjacent 60d windows, so these ICs are reported with wide uncertainty and are confirmatory only.' : ''}`;
// multiple testing
repl['MT_N'] = String(A.multipleTesting.N);
repl['MT_T'] = String(Math.round(A.multipleTesting.medianTripsT));
repl['MT_HURDLE'] = num(A.multipleTesting.deflatedSharpeHurdle);
repl['MT_OBS'] = num(A.multipleTesting.observedMaxPerTradeSharpe);
repl['MT_ABOVE'] = String(A.multipleTesting.nAboveHurdle);

// part B headline (realistic, conf 0.1)
function arm(method: string, lat: string, conf: string, which: string) {
  const cell = pooled[`${method}|lat=${lat}|conf=${conf}`];
  if (!cell || !cell[which]) return { n: 'n/a', mean: 'n/a', sr: 'n/a', win: 'n/a' };
  const a = cell[which];
  return { n: String(a.nTrades), mean: pct(a.meanRet, 2), sr: num(a.sharpe), win: num(a.winRate, 2) };
}
repl['PB_NENTRIES'] = String(pooled['winRate|lat=realistic|conf=0.1']?.nSelectedEntries ?? 'n/a');
repl['PB_NLEADERS'] = String(B.meta.nLeadersWithEthBtc);
repl['PB_OFFLB'] = String(B.meta.offlb);
repl['PB_GATE1'] = String(B.meta.gate1);
for (const [tag, method] of [['WR', 'winRate'], ['CO', 'consistency']] as const) {
  for (const [roman, which] of [['I', 'armI_unconditional'], ['II', 'armII_regimeGated'], ['III', 'armIII_regimeAlone'], ['IV', 'armIV_hold']] as const) {
    const a = arm(method, 'realistic', '0.1', which);
    repl[`${tag}_${roman}_N`] = a.n; repl[`${tag}_${roman}_MEAN`] = a.mean; repl[`${tag}_${roman}_SR`] = a.sr; repl[`${tag}_${roman}_WIN`] = a.win;
  }
}
// sensitivity
repl['S_INST_II'] = arm('winRate', 'instant', '0.1', 'armII_regimeGated').mean;
repl['S_INST_III'] = arm('winRate', 'instant', '0.1', 'armIII_regimeAlone').mean;
repl['S_REAL_II'] = arm('winRate', 'realistic', '0.1', 'armII_regimeGated').mean;
repl['S_REAL_III'] = arm('winRate', 'realistic', '0.1', 'armIII_regimeAlone').mean;
repl['S_STRICT_II'] = arm('winRate', 'realistic', '0.55', 'armII_regimeGated').mean;
repl['S_STRICT_III'] = arm('winRate', 'realistic', '0.55', 'armIII_regimeAlone').mean;
// comparison
repl['LB_TOP_IC'] = num(C.leaderboardTop500.pooledIC);
repl['LB_TOP_TT'] = num(C.leaderboardTop500.pTopTop, 3);
repl['LB_TOP_TB'] = num(C.leaderboardTop500.pTopBot, 3);
repl['LB_TOP_POS'] = num(C.leaderboardTop500.fwdTopPositiveFrac, 3);
repl['OFFLB_IC'] = num(A.persistence.winRate.pooledIC);
repl['ANTICIPATION_NOTE'] = `(Gate-1 fill-level anticipation result stands; this study does not re-measure it because following is already net-negative.)`;

let txt = fs.readFileSync(REPORT, 'utf8');
for (const [k, v] of Object.entries(repl)) txt = txt.split(`{${k}}`).join(v);
fs.writeFileSync(REPORT, txt);
const remaining = txt.match(/\{[A-Z_]+\}/g);
console.log('[report] filled', Object.keys(repl).length, 'tokens; remaining:', remaining ? [...new Set(remaining)].join(',') : 'none');
