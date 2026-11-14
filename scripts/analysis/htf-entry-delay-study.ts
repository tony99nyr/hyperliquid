/**
 * HTF-trend entry-delay study. READ-ONLY and descriptive: it prices the cost of entering
 * later than the paper lane does. It cannot pass or fail the lane.
 *
 * Rule (frozen): the repo signal `htfTrendRead` on completed daily bars. Baseline enters at
 * the open of the first fine bar after the signal close. Delay variants enter d hours later,
 * only if the latest completed fine close is beyond the broken 20-day channel level.
 *
 * Data: Hyperliquid public candleSnapshot (no key). Cached under
 * data/backups/hyperliquid-study/htf-entry-delay/ (gitignored). No database, no orders.
 *
 * Run: pnpm exec tsx --tsconfig tsconfig.scripts.json scripts/analysis/htf-entry-delay-study.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  htfTrendExitHit,
  htfTrendRead,
  type HtfBar,
  type HtfTrendRead,
} from '@/lib/scout/htf-trend-signal-business-logic';

const COINS = ['BTC', 'ETH', 'SOL', 'HYPE'] as const;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FEE_TOTAL = 0.0009; // 4.5 bps per side, both sides
const BOOT_DRAWS = 5000;
const BOOT_SEED = 20261114;
const OUT_DIR = join(process.cwd(), 'data/backups/hyperliquid-study/htf-entry-delay');
const API = 'https://api.hyperliquid.xyz/info';
const PAGE_LIMIT = 5000;

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

interface RawCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
}

type Side = 'long' | 'short';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- data ----------

async function fetchPage(coin: string, interval: string, start: number, end: number): Promise<RawCandle[]> {
  const body = { type: 'candleSnapshot', req: { coin, interval, startTime: start, endTime: end } };
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as RawCandle[];
    if (res.status !== 429 && res.status < 500) break;
    await sleep(2000 * (attempt + 1));
  }
  throw new Error(`HL request failed for ${coin} ${interval}`);
}

/** Load every candle HL serves for the coin and interval. Caches the raw pages to disk. */
async function loadCandles(coin: string, interval: string, ms: number, now: number): Promise<Candle[]> {
  const file = join(OUT_DIR, `${coin}_${interval}.json`);
  let raw: RawCandle[];
  if (existsSync(file)) {
    raw = JSON.parse(readFileSync(file, 'utf8')) as RawCandle[];
  } else {
    raw = [];
    let cursor = interval === '1d' ? Date.UTC(2022, 0, 1) : now - (PAGE_LIMIT - 20) * ms;
    for (;;) {
      const page = await fetchPage(coin, interval, cursor, now);
      await sleep(300);
      raw.push(...page);
      if (page.length < PAGE_LIMIT) break;
      cursor = page[page.length - 1].t + ms;
    }
    writeFileSync(file, JSON.stringify(raw));
  }
  const seen = new Map<number, Candle>();
  for (const r of raw) {
    seen.set(r.t, { t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) });
  }
  // Drop the in-progress bar: a bar is complete only when its close time has passed.
  return [...seen.values()].filter((c) => c.t + ms <= now).sort((a, b) => a.t - b.t);
}

// ---------- simulation ----------

interface Fine {
  hMs: number;
  bars: Candle[];
  idx: Map<number, number>;
}

interface Daily {
  bars: Candle[];
  idx: Map<number, number>;
  reads: (HtfTrendRead | null)[];
}

interface Outcome {
  open: boolean;
  exitPx: number;
  exitDayT: number;
  exitTime: number;
  reason: 'stop' | 'channel';
}

function makeFine(bars: Candle[], hMs: number): Fine {
  return { hMs, bars, idx: new Map(bars.map((b, i) => [b.t, i])) };
}

function makeDaily(bars: Candle[]): Daily {
  const hb: HtfBar[] = bars.map((b) => ({ highPx: b.h, lowPx: b.l, closePx: b.c }));
  const reads = bars.map((_, j) => htfTrendRead(hb.slice(0, j + 1)));
  return { bars, idx: new Map(bars.map((b, i) => [b.t, i])), reads };
}

/** Walk fine bars from the fill bar. Stop first, then the daily channel exit at each day close. */
function simulate(fine: Fine, daily: Daily, startIdx: number, side: Side, fillPx: number, stopFrac: number): Outcome {
  const stopPx = side === 'long' ? fillPx * (1 - stopFrac) : fillPx * (1 + stopFrac);
  for (let i = startIdx; i < fine.bars.length; i++) {
    const bar = fine.bars[i];
    const dayT = Math.floor(bar.t / DAY) * DAY;
    const hit = side === 'long' ? bar.l <= stopPx : bar.h >= stopPx;
    if (hit) {
      return { open: false, exitPx: stopPx, exitDayT: dayT, exitTime: bar.t + fine.hMs, reason: 'stop' };
    }
    if ((bar.t + fine.hMs) % DAY === 0) {
      const j = daily.idx.get(dayT);
      if (j === undefined) break;
      const read = daily.reads[j];
      if (read && htfTrendExitHit(read, side)) {
        return {
          open: false,
          exitPx: daily.bars[j].c,
          exitDayT: dayT,
          exitTime: bar.t + fine.hMs,
          reason: 'channel',
        };
      }
    }
  }
  return { open: true, exitPx: 0, exitDayT: 0, exitTime: 0, reason: 'channel' };
}

function rMultiple(side: Side, fill: number, exit: number, stopFrac: number): number {
  const sign = side === 'long' ? 1 : -1;
  return (sign * (exit - fill)) / (fill * stopFrac) - FEE_TOTAL / stopFrac;
}

interface Signal {
  coin: string;
  side: Side;
  level: number;
  stopFrac: number;
  t0: number;
  baseR: number;
  holdDays: number;
  reason: 'stop' | 'channel';
}

interface PanelRun {
  signals: Signal[];
  openAtEnd: number;
  missingFine: number;
  firstT0: number;
  coinSpans: Record<string, { from: string; to: string; bars: number; gaps: number }>;
}

/** Baseline walk for one coin: one position at a time, signals only inside the fine span. */
function baselineWalk(coin: string, fine: Fine, daily: Daily, out: Signal[]): { open: number; missing: number } {
  let open = 0;
  let missing = 0;
  const firstFine = fine.bars[0].t;
  let j = daily.bars.findIndex((b) => b.t + DAY >= firstFine);
  while (j >= 0 && j < daily.bars.length) {
    const brk = daily.reads[j]?.breakout;
    if (!brk) {
      j++;
      continue;
    }
    const t0 = daily.bars[j].t + DAY;
    const fi = fine.idx.get(t0);
    if (fi === undefined) {
      if (t0 < fine.bars[fine.bars.length - 1].t) missing++;
      j++;
      continue;
    }
    const fill = fine.bars[fi].o;
    const o = simulate(fine, daily, fi, brk.side, fill, brk.stopFrac);
    if (o.open) {
      open++;
      break;
    }
    out.push({
      coin,
      side: brk.side,
      level: brk.side === 'long' ? daily.reads[j]!.don20High : daily.reads[j]!.don20Low,
      stopFrac: brk.stopFrac,
      t0,
      baseR: rMultiple(brk.side, fill, o.exitPx, brk.stopFrac),
      holdDays: (o.exitTime - t0) / DAY,
      reason: o.reason,
    });
    const next = daily.idx.get(o.exitDayT);
    if (next === undefined || next < j) break;
    j = next === j ? j + 1 : next;
  }
  return { open, missing };
}

interface VariantResult {
  filled: boolean;
  unresolved: boolean;
  r: number;
}

function variant(sig: Signal, fine: Fine, daily: Daily, dHours: number): VariantResult {
  const none: VariantResult = { filled: false, unresolved: false, r: 0 };
  const beyond = (close: number) => (sig.side === 'long' ? close > sig.level : close < sig.level);
  for (let f = sig.t0 + dHours * HOUR; f < sig.t0 + DAY; f += fine.hMs) {
    const prev = fine.idx.get(f - fine.hMs);
    const fi = fine.idx.get(f);
    if (prev === undefined || fi === undefined) return none;
    if (!beyond(fine.bars[prev].c)) continue;
    const fill = fine.bars[fi].o;
    const o = simulate(fine, daily, fi, sig.side, fill, sig.stopFrac);
    if (o.open) return { filled: true, unresolved: true, r: 0 };
    return { filled: true, unresolved: false, r: rMultiple(sig.side, fill, o.exitPx, sig.stopFrac) };
  }
  return none;
}

// ---------- statistics ----------

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapCi(diffs: number[]): [number, number] {
  if (diffs.length < 2) return [NaN, NaN];
  const rnd = mulberry32(BOOT_SEED);
  const means: number[] = [];
  for (let b = 0; b < BOOT_DRAWS; b++) {
    let s = 0;
    for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rnd() * diffs.length)];
    means.push(s / diffs.length);
  }
  means.sort((a, b) => a - b);
  return [quantile(means, 0.025), quantile(means, 0.975)];
}

interface DelayRow {
  delayHours: number;
  nSignals: number;
  nFilled: number;
  fillRate: number;
  nUnresolved: number;
  baseMeanAll: number;
  baseMeanFilled: number;
  varMeanFilled: number;
  varMeanNoFillZero: number;
  pairedDiff: number;
  ciLow: number;
  ciHigh: number;
  perCoinSignals: Record<string, number>;
  perCoinFilled: Record<string, number>;
}

function delayRow(signals: Signal[], results: VariantResult[], d: number): DelayRow {
  const filledIdx = results.map((r, i) => (r.filled && !r.unresolved ? i : -1)).filter((i) => i >= 0);
  const baseFilled = filledIdx.map((i) => signals[i].baseR);
  const varFilled = filledIdx.map((i) => results[i].r);
  const diffs = filledIdx.map((i) => results[i].r - signals[i].baseR);
  const [ciLow, ciHigh] = bootstrapCi(diffs);
  const perCoinSignals: Record<string, number> = {};
  const perCoinFilled: Record<string, number> = {};
  signals.forEach((s) => (perCoinSignals[s.coin] = (perCoinSignals[s.coin] ?? 0) + 1));
  filledIdx.forEach((i) => (perCoinFilled[signals[i].coin] = (perCoinFilled[signals[i].coin] ?? 0) + 1));
  return {
    delayHours: d,
    nSignals: signals.length,
    nFilled: results.filter((r) => r.filled).length,
    fillRate: results.filter((r) => r.filled).length / signals.length,
    nUnresolved: results.filter((r) => r.unresolved).length,
    baseMeanAll: mean(signals.map((s) => s.baseR)),
    baseMeanFilled: mean(baseFilled),
    varMeanFilled: mean(varFilled),
    varMeanNoFillZero: varFilled.reduce((a, b) => a + b, 0) / signals.length,
    pairedDiff: mean(diffs),
    ciLow,
    ciHigh,
    perCoinSignals,
    perCoinFilled,
  };
}

// ---------- panels ----------

interface PanelOut {
  label: string;
  coinSpans: PanelRun['coinSpans'];
  openAtEnd: number;
  missingSignalFill: number;
  baseline: {
    n: number;
    meanR: number;
    holdDays: { median: number; p75: number; p90: number; p95: number; max: number };
    stopShare: number;
    channelShare: number;
  };
  delays: DelayRow[];
}

function runPanel(
  label: string,
  hMs: number,
  delays: number[],
  fineByCoin: Record<string, Candle[]>,
  dailyByCoin: Record<string, Daily>,
): PanelOut {
  const signals: Signal[] = [];
  const coinSpans: PanelRun['coinSpans'] = {};
  let openAtEnd = 0;
  let missing = 0;
  const fines: Record<string, Fine> = {};
  for (const coin of COINS) {
    const fine = makeFine(fineByCoin[coin], hMs);
    fines[coin] = fine;
    const r = baselineWalk(coin, fine, dailyByCoin[coin], signals);
    openAtEnd += r.open;
    missing += r.missing;
    const bars = fine.bars;
    coinSpans[coin] = {
      from: new Date(bars[0].t).toISOString(),
      to: new Date(bars[bars.length - 1].t + hMs).toISOString(),
      bars: bars.length,
      gaps: Math.round((bars[bars.length - 1].t - bars[0].t) / hMs) + 1 - bars.length,
    };
  }
  const holds = signals.map((s) => s.holdDays).sort((a, b) => a - b);
  const stops = signals.filter((s) => s.reason === 'stop').length;
  const rows = delays.map((d) => {
    const results = signals.map((s) => variant(s, fines[s.coin], dailyByCoin[s.coin], d));
    return delayRow(signals, results, d);
  });
  return {
    label,
    coinSpans,
    openAtEnd,
    missingSignalFill: missing,
    baseline: {
      n: signals.length,
      meanR: mean(signals.map((s) => s.baseR)),
      holdDays: {
        median: quantile(holds, 0.5),
        p75: quantile(holds, 0.75),
        p90: quantile(holds, 0.9),
        p95: quantile(holds, 0.95),
        max: holds[holds.length - 1] ?? NaN,
      },
      stopShare: stops / signals.length,
      channelShare: (signals.length - stops) / signals.length,
    },
    delays: rows,
  };
}

const f = (x: number, p = 3) => (Number.isFinite(x) ? x.toFixed(p) : 'NA');

function printPanel(p: PanelOut): void {
  console.log(`\n== ${p.label} ==`);
  for (const [c, s] of Object.entries(p.coinSpans)) {
    console.log(`${c}: ${s.from.slice(0, 10)} to ${s.to.slice(0, 10)}, ${s.bars} bars, ${s.gaps} gaps`);
  }
  const b = p.baseline;
  const h = b.holdDays;
  console.log(
    `baseline n=${b.n} meanR=${f(b.meanR)} hold days med=${f(h.median, 1)} p75=${f(h.p75, 1)} ` +
      `p90=${f(h.p90, 1)} p95=${f(h.p95, 1)} max=${f(h.max, 1)} stop=${f(b.stopShare * 100, 0)}% ` +
      `channel=${f(b.channelShare * 100, 0)}% open-at-end=${p.openAtEnd} no-fine-bar=${p.missingSignalFill}`,
  );
  console.log('d(h) | n | fill% | baseAll | baseFilled | varFilled | var(nofill=0) | paired diff [95% CI] | unres');
  for (const r of p.delays) {
    console.log(
      `${r.delayHours} | ${r.nSignals} | ${f(r.fillRate * 100, 0)} | ${f(r.baseMeanAll)} | ${f(r.baseMeanFilled)} | ` +
        `${f(r.varMeanFilled)} | ${f(r.varMeanNoFillZero)} | ${f(r.pairedDiff)} [${f(r.ciLow)}, ${f(r.ciHigh)}] | ${r.nUnresolved}`,
    );
  }
  const pc = p.delays[0]?.perCoinSignals ?? {};
  console.log(`per coin n: ${COINS.map((c) => `${c}=${pc[c] ?? 0}`).join(' ')}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const now = Date.now();
  const dailyByCoin: Record<string, Daily> = {};
  const fine4: Record<string, Candle[]> = {};
  const fine1: Record<string, Candle[]> = {};
  for (const coin of COINS) {
    dailyByCoin[coin] = makeDaily(await loadCandles(coin, '1d', DAY, now));
    fine4[coin] = await loadCandles(coin, '4h', 4 * HOUR, now);
    fine1[coin] = await loadCandles(coin, '1h', HOUR, now);
    console.log(`${coin}: 1d=${dailyByCoin[coin].bars.length} 4h=${fine4[coin].length} 1h=${fine1[coin].length}`);
  }
  const p4 = runPanel('4h panel', 4 * HOUR, [4, 8, 12, 16, 20], fine4, dailyByCoin);
  const p1 = runPanel('1h panel', HOUR, [1, 2, 3, 6, 12], fine1, dailyByCoin);
  printPanel(p4);
  printPanel(p1);
  const outFile = join(OUT_DIR, 'result.json');
  writeFileSync(outFile, JSON.stringify({ runAt: new Date(now).toISOString(), panels: [p4, p1] }, null, 2));
  console.log(`\nJSON: ${outFile}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
