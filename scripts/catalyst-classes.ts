/**
 * Read-only study: catalyst-class moves (Part A) and entry overshoot in R (Part B).
 * Pre-registration: docs/scout/PREREGISTRATION_catalyst-classes.md
 * HL info candles only; Supabase SELECT only. Output holds account data (Part B): keep it in the scratchpad.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cachedJson, hlCandles, loadStudyEnv, politeFetch, STUDY_CACHE_ROOT, supabaseSelect } from './_study-io';
import { isEventStraddle } from '@/lib/performance/lane-performance-business-logic';
import {
  CONTROLS_PER_EVENT, closeMapOf, controlTimes, movesFor, seededRng, statsOf, verdictOf,
  type ClassStats, type EventMoves,
} from '@/lib/backtest/catalyst-classes-business-logic';
import { buildVerdict, overshootOf, summariseOvershoot, type Overshoot, type OvershootSummary } from '@/lib/backtest/entry-overshoot-business-logic';

const SEED = 20261026;
const CACHE = path.join(STUDY_CACHE_ROOT, 'catalyst-classes');
const TIERS = [
  { name: 'bin15m', interval: '15m', ms: 15 * 60_000, verdict: true, binance: true },
  { name: '15m', interval: '15m', ms: 15 * 60_000, verdict: true, binance: false },
  { name: '1h', interval: '1h', ms: 3_600_000, verdict: true, binance: false },
  { name: '4h', interval: '4h', ms: 4 * 3_600_000, verdict: false, binance: false },
] as const;
const COINS_BY_CLASS = (cls: string, coin: string): string[] => (cls === 'HYPE_UNLOCK' ? ['HYPE'] : [coin, 'ETH']);

interface DateFile { classes: Record<string, { coin: string; times: string[] }> }

const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : 'n/a');
const num = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : 'n/a');

function statsLine(label: string, s: ClassStats, tier: string): string {
  const m15 = tier.startsWith('15m') || tier === 'bin15m' ? ` | T+15m med ${pct(s.medAbsM15)} p80 ${pct(s.p80AbsM15)} (n ${s.nM15})` : '';
  return `${label.padEnd(24)} n ${String(s.n).padStart(3)}${m15} | T+2h med ${pct(s.medAbsH2)} p80 ${pct(s.p80AbsH2)} | T+24h med ${pct(s.medAbsH24)} p80 ${pct(s.p80AbsH24)} | cont24 ${pct(s.continuation)}`;
}

async function loadCloses(coin: string, tierName: string, intervalMs: number, now: number): Promise<Map<number, number>> {
  const start = now - 5000 * intervalMs;
  const hourKey = Math.floor(now / 3_600_000);
  const rows = await cachedJson(CACHE, `${coin}-${tierName}-${hourKey}.json`, async () => {
    const out: Array<{ timestamp: number; close: number }> = [];
    for (let cursor = start; cursor < now; cursor += 1000 * intervalMs) {
      const page = await hlCandles(coin, tierName, cursor, Math.min(now, cursor + 1000 * intervalMs));
      out.push(...page.map((c) => ({ timestamp: c.timestamp, close: c.close })));
    }
    return [...new Map(out.map((c) => [c.timestamp, c])).values()].sort((a, b) => a.timestamp - b.timestamp);
  });
  return closeMapOf(rows, intervalMs);
}

const BIN_BASE = 'https://data.binance.vision/data/futures/um';

/** Binance Vision USD-M 15m klines, 2024-01 to now. Monthly zips for complete months, daily zips for the current month. */
async function loadBinanceCloses(coin: string, now: number): Promise<Map<number, number>> {
  const symbol = `${coin}USDT`;
  const dir = path.join(CACHE, 'binance-klines');
  await mkdir(dir, { recursive: true });
  const rows: Array<{ timestamp: number; close: number }> = [];
  const read = async (kind: 'monthly' | 'daily', stamp: string): Promise<boolean> => {
    const name = `${symbol}-15m-${stamp}.zip`;
    const file = path.join(dir, name);
    try { await readFile(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        const response = await politeFetch(`${BIN_BASE}/${kind}/klines/${symbol}/15m/${name}`, {}, { label: `Binance ${name}`, retries: 3 });
        await writeFile(file, Buffer.from(await response.arrayBuffer()));
      } catch (e) {
        if (e instanceof Error && e.message.endsWith('HTTP 404')) return false;
        throw e;
      }
    }
    const csv = execFileSync('unzip', ['-p', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const line of csv.trim().split(/\r?\n/)) {
      const cells = line.split(',');
      let open = Number(cells[0]);
      const close = Number(cells[4]);
      if (!Number.isFinite(open) || !Number.isFinite(close)) continue; // header row
      if (open > 1e14) open = Math.floor(open / 1000);
      rows.push({ timestamp: open, close });
    }
    return true;
  };
  const nowDate = new Date(now);
  for (let y = 2024; y <= nowDate.getUTCFullYear(); y++) {
    for (let m = 1; m <= 12; m++) {
      const stamp = `${y}-${String(m).padStart(2, '0')}`;
      const sameMonth = y === nowDate.getUTCFullYear() && m === nowDate.getUTCMonth() + 1;
      if (y === nowDate.getUTCFullYear() && m > nowDate.getUTCMonth() + 1) break;
      if (!sameMonth && await read('monthly', stamp)) continue;
      // Current month (or a month without a monthly file yet): daily archives.
      const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let d = 1; d <= days; d++) {
        if (Date.UTC(y, m - 1, d) >= now) break;
        await read('daily', `${stamp}-${String(d).padStart(2, '0')}`);
      }
    }
  }
  const unique = [...new Map(rows.map((r) => [r.timestamp, r])).values()];
  return closeMapOf(unique, 15 * 60_000);
}

async function partA(now: number, lines: string[]): Promise<void> {
  const file = JSON.parse(await readFile('data/events/catalyst-class-dates.json', 'utf8')) as DateFile;
  const allEvents = Object.values(file.classes).flatMap((c) => c.times.map(Date.parse));
  lines.push('PART A: catalyst-class moves', `run ${new Date(now).toISOString()}, seed ${SEED}, ${CONTROLS_PER_EVENT} controls per event`, '');
  const verdicts: string[] = [];
  for (const tier of TIERS) {
    const coins = tier.binance ? ['BTC', 'ETH'] : ['BTC', 'ETH', 'HYPE'];
    const closes = new Map<string, Map<number, number>>();
    for (const coin of coins) {
      closes.set(coin, tier.binance ? await loadBinanceCloses(coin, now) : await loadCloses(coin, tier.interval, tier.ms, now));
    }
    lines.push(`=== Tier ${tier.name}${tier.verdict ? '' : ' (descriptive only, no verdict)'} ===`);
    for (const [cls, def] of Object.entries(file.classes)) {
      for (const coin of COINS_BY_CLASS(cls, def.coin)) {
        const map = closes.get(coin);
        if (!map) continue; // coin not in this tier
        if (map.size === 0) { lines.push(`${cls} ${coin}: no candles`); continue; }
        const keys = [...map.keys()];
        const startMs = Math.min(...keys) - tier.ms;
        const endMs = Math.max(...keys);
        const events = def.times.map(Date.parse);
        const moves = events.map((t) => movesFor(t, tier.ms, map)).filter((m): m is EventMoves => m !== null);
        const rng = seededRng(SEED);
        const controls: EventMoves[] = [];
        for (const t of events) {
          for (const c of controlTimes(t, startMs, endMs, allEvents, rng)) {
            const m = movesFor(c, tier.ms, map);
            if (m) controls.push(m);
          }
        }
        const s = statsOf(moves);
        const primary = coin === def.coin || cls === 'HYPE_UNLOCK';
        lines.push(statsLine(`${cls} ${coin}`, s, tier.name) + (primary && tier.verdict ? ` => ${verdictOf(s)}` : ''));
        lines.push(statsLine(`  control ${coin}`, statsOf(controls), tier.name));
        if (primary && tier.verdict) verdicts.push(`${tier.name}|${cls}|${verdictOf(s)}|n=${s.n}`);
      }
    }
    lines.push('');
  }
  lines.push('FINAL VERDICT PER CLASS (finest verdict-eligible tier with n >= 15, else INSUFFICIENT)');
  for (const cls of Object.keys(file.classes)) {
    const eligible = verdicts.map((v) => v.split('|')).filter((v) => v[1] === cls && v[2] !== 'INSUFFICIENT');
    lines.push(`${cls}: ${eligible.length ? `${eligible[0][2]} (tier ${eligible[0][0]}, ${eligible[0][3]})` : 'INSUFFICIENT'}`);
  }
  lines.push('');
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const finite = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function entryOid(detail: unknown): string | null {
  try {
    const parsed: unknown = JSON.parse(text(detail));
    if (typeof parsed === 'object' && parsed !== null && 'entryOid' in parsed) {
      const raw = (parsed as { entryOid: unknown }).entryOid;
      return typeof raw === 'number' || typeof raw === 'string' ? String(raw) : null;
    }
  } catch { /* detail is not JSON */ }
  return null;
}

function summaryLine(label: string, s: OvershootSummary): string {
  return `${label.padEnd(22)} n ${String(s.n).padStart(3)} | bps mean ${s.meanBps.toFixed(1)} med ${s.medianBps.toFixed(1)} p80 ${s.p80Bps.toFixed(1)} | R mean ${num(s.meanR)} med ${num(s.medianR)} p80 ${num(s.p80R)} | R mean clipped>=0 ${num(s.meanRClipped)}`;
}

async function partB(lines: string[]): Promise<void> {
  const [ladders, rungs, fires, fills] = await Promise.all([
    supabaseSelect('ladders', 'id,title,mode,oco_group_id', { mode: 'eq.live' }),
    supabaseSelect('ladder_rungs', 'id,ladder_id,coin,side,action,trigger_px,stop_px,stop_frac', { action: 'eq.open' }),
    supabaseSelect('ladder_fires', 'id,ladder_id,rung_id,status,detail,fired_at', { status: 'eq.filled' }),
    supabaseSelect('fills', 'id,hl_order_id,px,coin,side,filled_at,reduce_only', { source: 'eq.live', reduce_only: 'eq.false' }),
  ]);
  const groups = new Map<string, number>();
  for (const l of ladders) { const g = text(l.oco_group_id); if (g) groups.set(g, (groups.get(g) ?? 0) + 1); }
  const ladderById = new Map(ladders.map((l) => [text(l.id), l]));
  const rungById = new Map(rungs.map((r) => [text(r.id), r]));
  const fillByOid = new Map(fills.map((f) => [text(f.hl_order_id), finite(f.px)]));
  const all: Overshoot[] = [];
  const event: Overshoot[] = [];
  const detail: string[] = [];
  const excl = { notLiveOrNotOpen: 0, noOid: 0, noFill: 0, noStop: 0 };
  for (const fire of fires) {
    const ladder = ladderById.get(text(fire.ladder_id));
    const rung = rungById.get(text(fire.rung_id));
    if (!ladder || !rung) { excl.notLiveOrNotOpen++; continue; }
    const oid = entryOid(fire.detail);
    let fillPx: number | null = null;
    if (oid) fillPx = fillByOid.get(oid) ?? null;
    else {
      // Time-window fallback, as in ladder-outcome-business-logic (10 s window, 1 s early jitter).
      const firedMs = Date.parse(text(fire.fired_at));
      const want = text(rung.side) === 'short' ? 'sell' : 'buy';
      const near = fills.filter((f) => text(f.coin) === text(rung.coin) && text(f.side) === want &&
        Date.parse(text(f.filled_at)) >= firedMs - 1_000 && Date.parse(text(f.filled_at)) <= firedMs + 10_000);
      const oids = new Set(near.map((f) => text(f.hl_order_id) || text(f.id)));
      if (oids.size === 1) fillPx = finite(near[0].px);
      else { excl.noFill++; continue; }
      excl.noOid++;
    }
    if (fillPx === null) { excl.noFill++; continue; }
    const trig = finite(rung.trigger_px);
    const o = trig === null ? null : overshootOf({
      side: text(rung.side) === 'short' ? 'short' : 'long', triggerPx: trig, fillPx,
      stopPx: finite(rung.stop_px), stopFrac: finite(rung.stop_frac),
    });
    if (!o) { excl.noStop++; continue; }
    all.push(o);
    const isEvent = isEventStraddle({ id: text(ladder.id), title: text(ladder.title), oco_group_id: text(ladder.oco_group_id) || null, mode: text(ladder.mode) }, groups);
    if (isEvent) event.push(o);
    detail.push(`${text(fire.fired_at).slice(0, 16)} ${text(rung.coin)} ${text(rung.side)} ${isEvent ? 'EVENT' : 'other'} trig ${trig} fill ${fillPx} => ${o.bps.toFixed(1)} bps, ${o.r.toFixed(3)} R`);
  }
  const ev = summariseOvershoot(event);
  lines.push('PART B: entry overshoot (live open rungs, filled)',
    `filled fires read ${fires.length}; not matched to a live open rung (excluded) ${excl.notLiveOrNotOpen}, matched by time window (no entryOid) ${excl.noOid}, excluded as unmatched or ambiguous ${excl.noFill}, no stop distance ${excl.noStop}`,
    summaryLine('all fills', summariseOvershoot(all)), summaryLine('event-straddle legs', ev),
    `VERDICT: ${buildVerdict(ev)} (bar: mean > 0.2R on >= 5 event legs; mean ${num(ev.meanR)}R on ${ev.n})`, '', 'per fill (account data, scratchpad only):', ...detail);
}

async function main(): Promise<void> {
  loadStudyEnv();
  const lines: string[] = [];
  const which = process.argv[2] ?? 'both';
  if (which === 'both' || which === 'a') await partA(Date.now(), lines);
  if (which === 'both' || which === 'b') await partB(lines);
  console.log(lines.join('\n'));
}

main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
