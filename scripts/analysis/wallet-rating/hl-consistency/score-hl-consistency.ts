/**
 * RISK-ADJUSTED CONSISTENCY scorer for Hyperliquid wallets.
 *
 * Applies configs/wallet-selection-hl-consistency-v0.1.0.json to the cached HL
 * study population (data/backups/hyperliquid-study/windows.json). Computes, per
 * wallet, risk-adjusted (Sharpe/Sortino/Calmar) + cross-window-consistency
 * metrics from the six 60-day window returns, grades A-F per category, applies
 * auto-disqualifiers, and prints a shortlist for MANUAL review.
 *
 * Offline only — no network. Run: npx tsx scripts/analysis/wallet-rating/hl-consistency/score-hl-consistency.ts
 */
import * as fs from 'fs';
import * as path from 'path';

// Repo root (this file is <repo>/scripts/analysis/wallet-rating/hl-consistency/...).
const REPO = path.resolve(__dirname, '../../../..');
const WINDOWS = path.join(REPO, 'data/backups/hyperliquid-study/windows.json');
const PERSISTENT = path.join(REPO, 'data/backups/hyperliquid-study/persistent-set.json');
const CONFIG_DIR = path.join(REPO, 'scripts/analysis/wallet-rating/configs');

/** Resolve the live consistency config from configs/manifest.json so the JSON manifest selects the version. */
function activeConfigPath(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'manifest.json'), 'utf8'));
    const fname = manifest?.activeByPhilosophy?.consistency;
    if (fname) return path.join(CONFIG_DIR, fname);
  } catch {
    /* fall through to default */
  }
  return path.join(CONFIG_DIR, 'wallet-selection-hl-consistency-v0.1.0.json');
}
const CONFIG = activeConfigPath();

// ---- minimal shapes (study artifacts) ----
interface WindowAccount {
  address: string;
  leaderboardTop: boolean;
  randomSample: boolean;
  displayName: string | null;
  returns: Array<number | null>;
  avgAccountValue: Array<number | null>;
  dailyVol: Array<number | null>;
  usableWindows: number;
  status: string;
}
interface WindowsFile {
  meta: { totalAccounts: number };
  accounts: WindowAccount[];
}
interface PersistentDiag {
  address: string;
  sharpeAnnual: number;
  maxDrawdownFrac: number;
  best5StepsShare: number;
}

// HL: 365 / 60 = 6.083 windows per year
const WINDOWS_PER_YEAR = 365 / 60;

function mean(a: number[]): number {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
}
function std(a: number[]): number {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
const GPA: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };

/** Grade where HIGHER is better (descending thresholds A..D). */
function gradeHigh(v: number, t: { gradeA: number; gradeB: number; gradeC: number; gradeD: number }): Grade {
  if (v >= t.gradeA) return 'A';
  if (v >= t.gradeB) return 'B';
  if (v >= t.gradeC) return 'C';
  if (v >= t.gradeD) return 'D';
  return 'F';
}
/** Grade where LOWER is better (ascending thresholds A..D). */
function gradeLow(v: number, t: { gradeA: number; gradeB: number; gradeC: number; gradeD: number }): Grade {
  if (v <= t.gradeA) return 'A';
  if (v <= t.gradeB) return 'B';
  if (v <= t.gradeC) return 'C';
  if (v <= t.gradeD) return 'D';
  return 'F';
}

interface Metrics {
  address: string;
  short: string;
  displayName: string | null;
  leaderboardTop: boolean;
  returns: number[];
  avgAccountValue: number;
  totalReturn: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  maxDrawdownFrac: number;
  worstWindowReturn: number;
  avgWithinWindowVol: number;
  positiveWindowFraction: number;
  bestWindowConcentration: number;
  returnSignStability: number;
  everBlewUp: boolean;
}

/** Cumulative compounded equity path from window returns (multiplicative). */
function maxDrawdownFrac(returns: number[]): number {
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 1;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function computeMetrics(a: WindowAccount): Metrics {
  const returns = a.returns.filter((r): r is number => r !== null);
  const avs = a.avgAccountValue.filter((v): v is number => v !== null);
  const vols = a.dailyVol.filter((v): v is number => v !== null);

  const m = mean(returns);
  const s = std(returns);
  const downside = returns.filter((r) => r < 0);
  // downside deviation about 0 (target return = 0)
  const dd = downside.length
    ? Math.sqrt(downside.reduce((acc, r) => acc + r * r, 0) / downside.length)
    : 0;

  const sqrtN = Math.sqrt(WINDOWS_PER_YEAR);
  const sharpe = s > 0 ? (m / s) * sqrtN : m > 0 ? 99 : 0;
  const sortino = dd > 0 ? (m / dd) * sqrtN : m > 0 ? 99 : 0;

  // total compounded return over the study period
  const totalReturn = returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const mdd = maxDrawdownFrac(returns);
  const calmar = mdd > 0 ? totalReturn / mdd : totalReturn > 0 ? 99 : 0;

  const posCount = returns.filter((r) => r > 0).length;
  const positiveWindowFraction = returns.length ? posCount / returns.length : 0;

  const totalPositive = returns.filter((r) => r > 0).reduce((s2, r) => s2 + r, 0);
  const bestWindow = Math.max(...returns, 0);
  const bestWindowConcentration = totalPositive > 0 ? bestWindow / totalPositive : 99;

  // sign-flip stability
  let flips = 0;
  for (let i = 1; i < returns.length; i++) {
    if (Math.sign(returns[i]) !== Math.sign(returns[i - 1]) && returns[i] !== 0 && returns[i - 1] !== 0) {
      flips++;
    }
  }
  const maxFlips = Math.max(1, returns.length - 1);
  const returnSignStability = 1 - flips / maxFlips;

  const worstWindowReturn = Math.min(...returns);
  // blew up: any window lost >100% of avg account value, or compounded equity hit <= 0
  let equity = 1;
  let wentZero = false;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity <= 0) wentZero = true;
  }
  const everBlewUp = returns.some((r) => r <= -1.0) || wentZero;

  return {
    address: a.address,
    short: a.address.slice(0, 8),
    displayName: a.displayName,
    leaderboardTop: a.leaderboardTop,
    returns,
    avgAccountValue: mean(avs),
    totalReturn,
    sharpe,
    sortino,
    calmar,
    maxDrawdownFrac: mdd,
    worstWindowReturn,
    avgWithinWindowVol: vols.length ? mean(vols) : NaN,
    positiveWindowFraction,
    bestWindowConcentration,
    returnSignStability,
    everBlewUp,
  };
}

interface Scored extends Metrics {
  catGrades: Record<string, Grade>;
  catScores: Record<string, number>;
  overallGPA: number;
  overallGrade: Grade;
  overallScore10: number;
  disqualified: boolean;
  breached: string[];
  badges: string[];
}

function letterFromGPA(gpa: number, bands: Record<string, number>): Grade {
  if (gpa >= bands.A) return 'A';
  if (gpa >= bands.B) return 'B';
  if (gpa >= bands.C) return 'C';
  if (gpa >= bands.D) return 'D';
  return 'F';
}

function score(m: Metrics, cfg: any): Scored {
  const rd = cfg.riskDiscipline;
  const perf = cfg.performance;
  const cons = cfg.consistency;
  const scaleCfg = cfg.ratingRubric.scale;

  // --- risk-adjusted performance ---
  const sharpeG = gradeHigh(m.sharpe, perf.sharpeAnnual);
  const sortinoG = gradeHigh(m.sortino, perf.sortinoAnnual);
  const calmarG = gradeHigh(m.calmar, perf.calmar);
  let rapScores = [GPA[sharpeG], GPA[sortinoG], GPA[calmarG]];
  // total-return sanity: floor failure caps profitability, suspicious-high caps at C
  const trs = perf.totalReturnSanity;
  let rapGPA = mean(rapScores);
  if (m.totalReturn < trs.floor) rapGPA = Math.min(rapGPA, GPA.D);
  else if (m.totalReturn > trs.suspiciousAbove) rapGPA = Math.min(rapGPA, GPA.C);

  // --- consistency ---
  const pwfG = gradeHigh(m.positiveWindowFraction, cons.positiveWindowFraction);
  const bwcG = gradeLow(m.bestWindowConcentration, cons.bestWindowConcentration);
  const ssG = gradeHigh(m.returnSignStability, cons.returnSignStability);
  const consGPA = mean([GPA[pwfG], GPA[bwcG], GPA[ssG]]);

  // --- tail safety ---
  const mddG = gradeLow(m.maxDrawdownFrac, rd.maxDrawdownFrac);
  // worstWindowReturn: higher (less negative) is better
  const wwrG = gradeHigh(m.worstWindowReturn, rd.worstWindowReturn);
  const volG = Number.isFinite(m.avgWithinWindowVol)
    ? gradeLow(m.avgWithinWindowVol, rd.avgWithinWindowVol)
    : 'C';
  const tailGPA = mean([GPA[mddG], GPA[wwrG], GPA[volG]]);

  // --- scale ---
  let scaleG: Grade;
  const av = m.avgAccountValue;
  if (av >= scaleCfg.gradeA_avgAccountValueUsd) scaleG = 'A';
  else if (av >= scaleCfg.gradeB) scaleG = 'B';
  else if (av >= scaleCfg.gradeC) scaleG = 'C';
  else if (av >= scaleCfg.gradeD) scaleG = 'D';
  else scaleG = 'F';
  const scaleGPA = GPA[scaleG];

  const cats = cfg.ratingRubric.categories;
  const catScores: Record<string, number> = {
    riskAdjustedPerformance: rapGPA,
    consistency: consGPA,
    tailSafety: tailGPA,
    scale: scaleGPA,
  };
  const catGrades: Record<string, Grade> = {
    riskAdjustedPerformance: letterFromGPA(rapGPA, cfg.overall.gradeBands),
    consistency: letterFromGPA(consGPA, cfg.overall.gradeBands),
    tailSafety: letterFromGPA(tailGPA, cfg.overall.gradeBands),
    scale: scaleG,
  };

  let overallGPA = 0;
  for (const [name, c] of Object.entries(cats) as Array<[string, { weight: number }]>) {
    overallGPA += c.weight * catScores[name];
  }

  // --- auto-disqualifiers (thresholds from config; JSON is source of truth) ---
  const mddReject = rd.maxDrawdownFrac.hardReject;
  const wwrReject = rd.worstWindowReturn.hardRejectBelow;
  const sharpeFloor = perf.sharpeAnnual.floor ?? 0;
  const breached: string[] = [];
  if (m.everBlewUp) breached.push('everBlewUp == true');
  if (m.maxDrawdownFrac > mddReject) breached.push(`maxDrawdownFrac > ${mddReject}`);
  if (m.worstWindowReturn < wwrReject) breached.push(`worstWindowReturn < ${wwrReject}`);
  if (m.positiveWindowFraction < cons.positiveWindowFraction.hardRejectBelow)
    breached.push(`positiveWindowFraction < ${cons.positiveWindowFraction.hardRejectBelow}`);
  if (m.bestWindowConcentration > cons.bestWindowConcentration.hardRejectAbove)
    breached.push(`bestWindowConcentration > ${cons.bestWindowConcentration.hardRejectAbove}`);
  if (m.sharpe < sharpeFloor) breached.push(`sharpeAnnual < ${sharpeFloor}`);

  const disqualified = breached.length > 0;
  if (disqualified) {
    overallGPA = 0;
    catGrades.riskAdjustedPerformance = 'F';
    catGrades.consistency = 'F';
    catGrades.tailSafety = 'F';
  }

  const overallGrade = disqualified ? 'F' : letterFromGPA(overallGPA, cfg.overall.gradeBands);
  const overallScore10 = (overallGPA / 4) * 10;

  // --- badges (thresholds from config; JSON is source of truth) ---
  const bt = cfg.uiHints?.badgeThresholds ?? {
    twoBurstsConcentrationAbove: 1.0,
    twoBurstsPositiveFractionAtOrBelow: 0.5,
    deepDrawdownAbove: 1.0,
    cleanBookMaxDrawdownAtOrBelow: 0.5,
    cleanBookPositiveFractionAtOrAbove: 0.83,
    cleanBookSharpeAtOrAbove: 1.3,
  };
  const badges: string[] = [];
  if (disqualified) badges.push('DISQUALIFIED');
  if (m.everBlewUp) badges.push('BLEW_UP');
  if (m.bestWindowConcentration > bt.twoBurstsConcentrationAbove || m.positiveWindowFraction <= bt.twoBurstsPositiveFractionAtOrBelow)
    badges.push('TWO_BURSTS');
  if (m.maxDrawdownFrac > bt.deepDrawdownAbove) badges.push('DEEP_DRAWDOWN');
  if (m.totalReturn > trs.suspiciousAbove) badges.push('LOTTERY_RETURN');
  if (m.maxDrawdownFrac <= bt.cleanBookMaxDrawdownAtOrBelow && m.positiveWindowFraction >= bt.cleanBookPositiveFractionAtOrAbove && m.sharpe >= bt.cleanBookSharpeAtOrAbove)
    badges.push('CLEAN_BOOK');

  return {
    ...m,
    catGrades,
    catScores,
    overallGPA,
    overallGrade,
    overallScore10,
    disqualified,
    breached,
    badges,
  };
}

function main(): void {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const wf: WindowsFile = JSON.parse(fs.readFileSync(WINDOWS, 'utf8'));
  const persistent: { diagnostics: PersistentDiag[] } = JSON.parse(fs.readFileSync(PERSISTENT, 'utf8'));
  const persistentAddrs = new Set(persistent.diagnostics.map((d) => d.address));

  const elig = cfg.eligibility;
  const total = wf.accounts.length;

  const eligible = wf.accounts.filter(
    (a) =>
      a.status === elig.requireStatus &&
      a.usableWindows >= elig.minUsableWindows &&
      a.returns.filter((r) => r !== null).length >= elig.minUsableWindows,
  );

  const scored = eligible
    .map((a) => computeMetrics(a))
    .filter((m) => m.avgAccountValue >= elig.minAvgAccountValueUsd)
    .map((m) => score(m, cfg));

  const survivors = scored.filter((s) => !s.disqualified);
  survivors.sort((a, b) => b.overallScore10 - a.overallScore10);

  const persistentScored = scored.filter((s) => persistentAddrs.has(s.address));
  const persistentSurviving = persistentScored.filter((s) => !s.disqualified);

  // ---- report ----
  console.log('='.repeat(100));
  console.log('RISK-ADJUSTED CONSISTENCY — Hyperliquid wallet shortlist');
  console.log(`config: ${cfg.name} v${cfg.version}`);
  console.log('='.repeat(100));
  console.log(`Universe (study totalAccounts):      ${total}`);
  console.log(`Eligible (status=usable, 6 windows): ${eligible.length}`);
  console.log(`Scored (>= $${elig.minAvgAccountValueUsd} avg AV):       ${scored.length}`);
  console.log(`Disqualified:                        ${scored.length - survivors.length}`);
  console.log(`SURVIVORS (graded, not DQ'd):        ${survivors.length}`);
  const aOrB = survivors.filter((s) => s.overallGrade === 'A' || s.overallGrade === 'B').length;
  console.log(`  of which grade A or B:             ${aOrB}`);
  console.log(
    `Persistent-set (43) in scored pool:  ${persistentScored.length}; surviving (not DQ'd): ${persistentSurviving.length}`,
  );
  console.log('');

  console.log('TOP 15 SHORTLIST (sorted by overall 0-10):');
  console.log('-'.repeat(100));
  const hdr = [
    'rank'.padEnd(4),
    'address'.padEnd(10),
    'ovr'.padEnd(4),
    '0-10'.padEnd(5),
    'RAP'.padEnd(4),
    'CON'.padEnd(4),
    'TAIL'.padEnd(5),
    'Shrp'.padEnd(6),
    'Sort'.padEnd(6),
    'Calm'.padEnd(6),
    'pos%'.padEnd(5),
    'conc'.padEnd(6),
    'mDD'.padEnd(6),
    'wrst'.padEnd(7),
    'totRet'.padEnd(8),
    'avgAV'.padEnd(10),
  ];
  console.log(hdr.join(' '));
  survivors.slice(0, 15).forEach((s, i) => {
    const row = [
      String(i + 1).padEnd(4),
      s.short.padEnd(10),
      s.overallGrade.padEnd(4),
      s.overallScore10.toFixed(1).padEnd(5),
      s.catGrades.riskAdjustedPerformance.padEnd(4),
      s.catGrades.consistency.padEnd(4),
      s.catGrades.tailSafety.padEnd(5),
      s.sharpe.toFixed(2).padEnd(6),
      s.sortino.toFixed(2).padEnd(6),
      s.calmar.toFixed(2).padEnd(6),
      (s.positiveWindowFraction * 100).toFixed(0).padEnd(5),
      s.bestWindowConcentration.toFixed(2).padEnd(6),
      s.maxDrawdownFrac.toFixed(2).padEnd(6),
      s.worstWindowReturn.toFixed(2).padEnd(7),
      s.totalReturn.toFixed(2).padEnd(8),
      ('$' + Math.round(s.avgAccountValue).toLocaleString()).padEnd(10),
    ];
    const flags = s.badges.length ? '  [' + s.badges.join(',') + ']' : '';
    const persist = persistentAddrs.has(s.address) ? ' *PERSIST*' : '';
    console.log(row.join(' ') + flags + persist);
  });

  console.log('');
  console.log('How the 43 persistent-set accounts fared under this ranker:');
  console.log('-'.repeat(100));
  persistentScored
    .sort((a, b) => b.overallScore10 - a.overallScore10)
    .forEach((s) => {
      const rank = survivors.findIndex((x) => x.address === s.address);
      console.log(
        `${s.short}  ${s.overallGrade} ${s.overallScore10.toFixed(1)}/10  ` +
          `Sharpe ${s.sharpe.toFixed(2)} pos% ${(s.positiveWindowFraction * 100).toFixed(0)} ` +
          `conc ${s.bestWindowConcentration.toFixed(2)} mDD ${s.maxDrawdownFrac.toFixed(2)} ` +
          `${s.disqualified ? 'DQ:[' + s.breached.join(';') + ']' : 'shortlist#' + (rank + 1)}`,
      );
    });

  // emit JSON for downstream UI
  const out = {
    config: `${cfg.name} v${cfg.version}`,
    generatedAt: new Date().toISOString(),
    counts: {
      total,
      eligible: eligible.length,
      scored: scored.length,
      survivors: survivors.length,
      gradeAorB: aOrB,
      persistentInPool: persistentScored.length,
      persistentSurviving: persistentSurviving.length,
    },
    shortlist: survivors.slice(0, 15),
  };
  const outPath = path.join(__dirname, 'shortlist-hl-consistency.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main();
