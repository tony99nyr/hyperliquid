#!/usr/bin/env node
/**
 * Consolidate the four Hyperliquid wallet-rating bake-off shortlists into a
 * single dataset the Wallet Copy-Monitor UI reads:
 *   data/backups/wallet-rating/rated-wallets.json
 *
 * Sources (one philosophy each):
 *   - hl-consistency/shortlist-hl-consistency.json  → "consistency"
 *   - hl-skill-shortlist.json                       → "skill"
 *   - hl-survivor-results.json                      → "survivor"
 *   - copyability-shortlist.json (hyperliquid-study)→ "copyability"
 *
 * Output schema is documented in rated-wallets.SCHEMA.md.
 *
 * Run: node scripts/analysis/wallet-rating/consolidate-rated-wallets.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const p = (rel) => resolve(repoRoot, rel);

const readJson = (rel) => JSON.parse(readFileSync(p(rel), 'utf8'));

// --- Config: the user's watch window (America/New_York, EDT/EST). ---
// `daytimeActivePct` is computed against this window. Read from the active
// COPYABILITY config's tradingActivity section (the copy-trading lens owns the
// watch-window knob) so the JSON config is the single source of truth. The UI
// reads watchWindowEdt back out of the generated dataset.
const CONFIG_DIR = p('scripts/analysis/wallet-rating/configs');
function loadTradingActivityConfig() {
  const fallback = {
    watchWindowEdt: { startHour: 8, endHour: 22 },
    overnightThreshold: 0.4,
    peakHoursCount: 3,
  };
  try {
    const manifest = JSON.parse(readFileSync(join(CONFIG_DIR, 'manifest.json'), 'utf8'));
    const fname = manifest?.activeByPhilosophy?.copyability;
    if (!fname) return fallback;
    const cfg = JSON.parse(readFileSync(join(CONFIG_DIR, fname), 'utf8'));
    const ta = cfg.tradingActivity;
    if (!ta) return fallback;
    return {
      watchWindowEdt: ta.watchWindowEdt ?? fallback.watchWindowEdt,
      overnightThreshold: ta.overnightThreshold ?? fallback.overnightThreshold,
      peakHoursCount: ta.peakHoursCount ?? fallback.peakHoursCount,
    };
  } catch {
    return fallback;
  }
}
const TA_CONFIG = loadTradingActivityConfig();
const WATCH_WINDOW_EDT = TA_CONFIG.watchWindowEdt;
// daytimeActivePct below this → TRADES_OVERNIGHT_EDT badge.
const OVERNIGHT_THRESHOLD = TA_CONFIG.overnightThreshold;
const PEAK_HOURS_COUNT = TA_CONFIG.peakHoursCount;

// --- Cached fills (for trading-hours analytics) ---
const FILLS_DIR = p('data/backups/hyperliquid-study/fills');

/**
 * Convert an epoch-ms timestamp to the hour-of-day (0-23) in America/New_York,
 * correctly handling EST/EDT DST via Intl (no manual offset math).
 */
const EDT_HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  hour12: false,
});
function edtHour(ms) {
  // Intl returns "24" for midnight in hour12:false; normalize to 0.
  const h = parseInt(EDT_HOUR_FMT.format(new Date(ms)), 10);
  return h === 24 ? 0 : h;
}

function inWatchWindow(hour) {
  const { startHour, endHour } = WATCH_WINDOW_EDT;
  if (startHour <= endHour) return hour >= startHour && hour < endHour;
  // Wrap-around window (e.g. 22→6).
  return hour >= startHour || hour < endHour;
}

/** Build tradingActivity from a wallet's cached fills, or null if none. */
function buildTradingActivity(addressLower) {
  const file = join(FILLS_DIR, `${addressLower}.json`);
  if (!existsSync(file)) return null;
  let fills;
  try {
    fills = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(fills) || fills.length === 0) return null;

  const hist = new Array(24).fill(0);
  let total = 0;
  for (const f of fills) {
    const t = typeof f.time === 'number' ? f.time : parseInt(f.time, 10);
    if (!Number.isFinite(t)) continue;
    hist[edtHour(t)] += 1;
    total += 1;
  }
  if (total === 0) return null;

  const hourHistogramEdt = hist.map((c) => Math.round((c / total) * 1000) / 1000);
  let daytime = 0;
  for (let h = 0; h < 24; h++) if (inWatchWindow(h)) daytime += hist[h];
  const daytimeActivePct = Math.round((daytime / total) * 1000) / 1000;

  const peakHoursEdt = hist
    .map((c, h) => ({ h, c }))
    .sort((a, b) => b.c - a.c)
    .slice(0, PEAK_HOURS_COUNT)
    .filter((x) => x.c > 0)
    .map((x) => x.h);

  return {
    hourHistogramEdt,
    daytimeActivePct,
    overnightPct: Math.round((1 - daytimeActivePct) * 1000) / 1000,
    peakHoursEdt,
    nFillsAnalyzed: total,
  };
}

const consistency = readJson('scripts/analysis/wallet-rating/hl-consistency/shortlist-hl-consistency.json');
const skill = readJson('scripts/analysis/wallet-rating/hl-skill-shortlist.json');
const survivor = readJson('scripts/analysis/wallet-rating/hl-survivor-results.json');
const copyability = readJson('data/backups/hyperliquid-study/copyability-shortlist.json');

/** wallets[addressLower] = consolidated record */
const wallets = new Map();

const norm = (addr) => addr.toLowerCase();

const ensure = (addr, displayName) => {
  const key = norm(addr);
  if (!wallets.has(key)) {
    wallets.set(key, {
      address: key,
      short: `${key.slice(0, 6)}…${key.slice(-4)}`,
      displayName: displayName ?? null,
      grades: {}, // philosophy → { grade, score10 }
      composite: null,
      flags: [], // deduped set of badge/flag strings
      metrics: {}, // best-available key metrics
      sources: [], // which philosophies rated this wallet
    });
  }
  const w = wallets.get(key);
  if (!w.displayName && displayName) w.displayName = displayName;
  return w;
};

const addFlags = (w, list) => {
  for (const f of list ?? []) {
    if (f && !w.flags.includes(f)) w.flags.push(f);
  }
};

// Only surface raw metric values when present (don't clobber a real number with null).
const setMetric = (w, key, val) => {
  if (val === null || val === undefined || Number.isNaN(val)) return;
  if (w.metrics[key] === undefined || w.metrics[key] === null) w.metrics[key] = val;
};

// ---- Consistency ----
for (const x of consistency.shortlist) {
  const w = ensure(x.address, x.displayName);
  w.grades.consistency = { grade: x.overallGrade, score10: round1(x.overallScore10) };
  w.sources.push('consistency');
  addFlags(w, x.badges);
  if (x.disqualified) addFlags(w, ['DISQUALIFIED']);
  setMetric(w, 'sharpe', round2(x.sharpe));
  setMetric(w, 'maxDrawdownFrac', round3(x.maxDrawdownFrac));
  setMetric(w, 'aggregatePnlUsd', null); // not in this source
  setMetric(w, 'avgAccountValue', Math.round(x.avgAccountValue));
  setMetric(w, 'totalReturn', round2(x.totalReturn));
  if (x.leaderboardTop) w.leaderboardTop = true;
}

// ---- Skill ----
for (const x of skill.shortlist) {
  const w = ensure(x.address, x.displayName);
  w.grades.skill = { grade: x.overallGrade, score10: round1(x.overallScore0to10) };
  w.sources.push('skill');
  addFlags(w, x.badges);
  if (x.disqualified) addFlags(w, ['DISQUALIFIED']);
  setMetric(w, 'sharpe', round2(x.sharpeAnnual));
  setMetric(w, 'maxDrawdownFrac', round3(x.maxDrawdownFrac));
  setMetric(w, 'aggregatePnlUsd', x.studyPeriodPnlUsd != null ? Math.round(x.studyPeriodPnlUsd) : null);
  setMetric(w, 'totalReturn', round2(x.studyPeriodReturn));
  setMetric(w, 'memeShare', round3(x.memeShare));
  if (x.anticipationLabel) w.anticipationLabel = x.anticipationLabel;
  if (x.leaderboardTop) w.leaderboardTop = true;
}

// ---- Survivor ----
for (const x of survivor.results) {
  const w = ensure(x.address, x.displayName);
  w.grades.survivor = { grade: x.overallGrade, score10: round1(x.score10) };
  w.sources.push('survivor');
  addFlags(w, x.flags);
  if (x.disqualified) addFlags(w, ['DISQUALIFIED']);
  const m = x.metrics ?? {};
  setMetric(w, 'sharpe', round2(m.sharpeAnnual));
  setMetric(w, 'maxDrawdownFrac', round3(m.maxDrawdownFrac));
  setMetric(w, 'winRate', round3(m.roundTripWinRate));
  setMetric(w, 'profitFactor', round2(m.profitFactor));
  setMetric(w, 'worstLossVsMedianWin', round2(m.worstLossVsMedianWin));
  setMetric(w, 'totalReturn', round2(m.studyPeriodReturn));
  setMetric(w, 'avgAccountValue', m.avgAccountValue != null ? Math.round(m.avgAccountValue) : null);
  setMetric(w, 'accountAgeDays', m.accountAgeDays != null ? Math.round(m.accountAgeDays) : null);
}

// ---- Copyability (the copy-trading-specific lens; richest metrics) ----
for (const x of copyability) {
  const w = ensure(x.address);
  const r = x.rating ?? {};
  w.grades.copyability = { grade: r.overallGrade, score10: round1(r.overallScore) };
  w.sources.push('copyability');
  addFlags(w, r.flags);
  addFlags(w, r.disqualifiers);
  if ((r.disqualifiers ?? []).length > 0) addFlags(w, ['DISQUALIFIED']);
  if (r.leadsVault) addFlags(w, ['VAULT_LED']);
  const m = x.metrics ?? {};
  setMetric(w, 'winRate', round3(m.winRate));
  setMetric(w, 'profitFactor', round2(m.profitFactor));
  setMetric(w, 'worstLossVsMedianWin', round2(m.worstLossVsMedianWin));
  setMetric(w, 'aggregatePnlUsd', m.aggregateNetPnlUsd != null ? Math.round(m.aggregateNetPnlUsd) : null);
  setMetric(w, 'majorsShare', round3(m.majorsShare));
  setMetric(w, 'medianHoldHours', round2(m.medianHoldHours));
  setMetric(w, 'maxAddDepth', m.maxAddDepth);
  setMetric(w, 'medianAddDepth', m.medianAddDepth);
  setMetric(w, 'reserveMultiple', round2(m.reserveMultiple));
  setMetric(w, 'liquidations', m.liquidations);
  setMetric(w, 'nFills', m.nFills);
  setMetric(w, 'distinctCoins', m.distinctCoins);
  setMetric(w, 'subMinuteFrac', round3(m.subMinuteFrac));
  setMetric(w, 'openPeakVsMedianPeak', round2(m.openPeakVsMedianPeak));
  if (Array.isArray(m.topCoins)) w.topCoins = m.topCoins;
  if (m.worstOpen) w.worstOpen = m.worstOpen;
}

// ---- Composite + finalize ----
const out = [];
for (const w of wallets.values()) {
  const scores = Object.values(w.grades)
    .map((g) => g.score10)
    .filter((s) => typeof s === 'number' && !Number.isNaN(s));
  w.composite = scores.length ? round1(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  w.sources = [...new Set(w.sources)].sort();

  // Trading-hours analytics from cached fills (EDT-bucketed). null if no fills.
  w.tradingActivity = buildTradingActivity(w.address);
  if (!w.tradingActivity) {
    addFlags(w, ['NO_FILL_DATA']);
  } else if (w.tradingActivity.daytimeActivePct < OVERNIGHT_THRESHOLD) {
    addFlags(w, ['TRADES_OVERNIGHT_EDT']);
  }

  // Stable flag order: DISQUALIFIED first, then alpha.
  w.flags.sort((a, b) => (a === 'DISQUALIFIED' ? -1 : b === 'DISQUALIFIED' ? 1 : a.localeCompare(b)));
  out.push(w);
}

// Default sort: composite desc, then more sources, then address.
out.sort((a, b) => {
  if ((b.composite ?? -1) !== (a.composite ?? -1)) return (b.composite ?? -1) - (a.composite ?? -1);
  if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
  return a.address.localeCompare(b.address);
});

const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  description:
    'Consolidated Hyperliquid wallet ratings merged from four philosophy bake-offs ' +
    '(consistency, skill, survivor, copyability). Read-only decision-support for the ' +
    'Wallet Copy-Monitor tool. See rated-wallets.SCHEMA.md.',
  philosophies: ['consistency', 'skill', 'survivor', 'copyability'],
  watchWindowEdt: WATCH_WINDOW_EDT,
  knownFlags: [
    'DISQUALIFIED', 'EXTREME_WIN_RATE', 'LIVE_DEEP_STACK', 'NO_STOPS',
    'DEEP_MARTINGALE', 'THIN_ALT_TRADER', 'SUB_MINUTE_SCALPER', 'VAULT_LED',
    'CLEAN_BOOK', 'PERSISTENT_SET', 'DEEP_DRAWDOWN', 'FAT_WORST_LOSS',
    'LIVE_UNDERWATER', 'RIDE_OR_LIQUIDATE', 'BLOW_UP_RISK', 'PROVISIONAL_NO_FILLS',
    'ANTICIPATION_UNMEASURED', 'REACTS_NOT_ANTICIPATES',
    'TRADES_OVERNIGHT_EDT', 'NO_FILL_DATA',
  ],
  count: out.length,
  wallets: out,
};

const outPath = p('data/backups/wallet-rating/rated-wallets.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');

console.log(`Wrote ${out.length} consolidated wallets → ${outPath}`);
console.log(`  with composite: ${out.filter((w) => w.composite != null).length}`);
console.log(`  multi-philosophy: ${out.filter((w) => w.sources.length > 1).length}`);
console.log(`  with trading-hours data: ${out.filter((w) => w.tradingActivity).length}`);
console.log(`  flagged TRADES_OVERNIGHT_EDT: ${out.filter((w) => w.flags.includes('TRADES_OVERNIGHT_EDT')).length}`);

// --- rounding helpers ---
function round1(n) { return n == null || Number.isNaN(n) ? null : Math.round(n * 10) / 10; }
function round2(n) { return n == null || Number.isNaN(n) ? null : Math.round(n * 100) / 100; }
function round3(n) { return n == null || Number.isNaN(n) ? null : Math.round(n * 1000) / 1000; }
