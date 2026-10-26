/**
 * Study: replay the frozen event-straddle rule on HIP-3 (xyz dex) equity perps around earnings.
 * Pre-registration: docs/scout/PREREGISTRATION_hip3-earnings-straddle.md. Read-only HL info calls.
 * Usage: pnpm study:hip3-earnings
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { STUDY_CACHE_ROOT, cachedJson, hlCandles, hlInfo } from './_study-io';
import {
  FROZEN_CONFIG_1H, replayStraddleEvent, summarise, type EventResult, type ReplayConfig, type StudyCandle,
} from '@/lib/backtest/hip3-earnings-straddle-business-logic';

interface EarningsEvent { coin: string; ticker: string; printAtUtc: string; timing: 'AMC' | 'BMO'; date: string; source: string }

const CACHE = path.join(STUDY_CACHE_ROOT, 'hip3');
const MAX_AGE = 6 * 3_600_000;
const fmt = (v: number | null, d = 3): string => (v === null ? 'n/a' : v.toFixed(d));

async function candlesFor(coin: string, interval: '1h' | '15m'): Promise<StudyCandle[]> {
  const end = Date.now();
  const start = end - (interval === '1h' ? 5100 * 3_600_000 : 5100 * 900_000);
  const name = `${coin.replace(':', '_')}-${interval}.json`;
  return cachedJson(CACHE, name, async () => (await hlCandles(coin, interval, start, end)) as StudyCandle[], MAX_AGE);
}

function run(events: EventsWithCandles[], config: ReplayConfig): Array<{ event: EarningsEvent; result: EventResult }> {
  return events.map(({ event, candles }) => ({
    event, result: replayStraddleEvent(candles, Date.parse(event.printAtUtc), config),
  }));
}
interface EventsWithCandles { event: EarningsEvent; candles: StudyCandle[] }

function report(label: string, rows: Array<{ event: EarningsEvent; result: EventResult }>): void {
  const s = summarise(rows.map((r) => r.result));
  const inelig = rows.filter((r) => r.result.state === 'ineligible').length;
  console.log(`\n== ${label} ==`);
  console.log(`n=${s.n} (filled ${s.filled}, no-fill ${s.noFill}, ineligible ${inelig}) meanR=${fmt(s.meanR)} ` +
    `meanR(filled)=${fmt(s.meanRFilled)} win=${fmt(s.winRate, 2)} exTop3=${fmt(s.meanRExTop3)} ` +
    `ci95=${s.ci95 ? `[${fmt(s.ci95[0])}, ${fmt(s.ci95[1])}]` : 'n/a'}`);
  console.log(`checks: mean>=0.2 ${s.checks.mean}, n>=30 ${s.checks.n}, exTop3>0 ${s.checks.exTop3} -> ${s.verdict}`);
}

function splitBy(label: string, rows: Array<{ event: EarningsEvent; result: EventResult }>,
  key: (e: EarningsEvent) => string): void {
  const groups = new Map<string, EventResult[]>();
  for (const { event, result } of rows) groups.set(key(event), [...(groups.get(key(event)) ?? []), result]);
  console.log(`\n-- split by ${label} (eligible n, meanR) --`);
  for (const [k, results] of [...groups.entries()].sort()) {
    const s = summarise(results);
    console.log(`${k.padEnd(10)} n=${s.n} filled=${s.filled} meanR=${fmt(s.meanR)}`);
  }
}

async function main(): Promise<void> {
  const file = JSON.parse(await readFile('data/scout/hip3-earnings-events.json', 'utf8')) as { events: EarningsEvent[] };
  const meta = await hlInfo<{ universe: Array<{ name: string }> }>({ type: 'meta', dex: 'xyz' });
  const listed = new Set(meta.universe.map((u) => u.name));
  console.log(`xyz universe size ${listed.size}; events ${file.events.length}`);
  const coins = [...new Set(file.events.map((e) => e.coin))];
  const missing = coins.filter((c) => !listed.has(c));
  if (missing.length) console.log(`WARNING coins not in xyz meta: ${missing.join(', ')}`);

  const by1h = new Map<string, StudyCandle[]>();
  for (const coin of coins) by1h.set(coin, await candlesFor(coin, '1h'));
  const withCandles = file.events.map((event) => ({ event, candles: by1h.get(event.coin) ?? [] }));
  for (const coin of coins) {
    const c = by1h.get(coin) ?? [];
    console.log(`${coin.padEnd(10)} 1h candles ${c.length} from ${c.length ? new Date(c[0].timestamp).toISOString().slice(0, 10) : 'n/a'}`);
  }

  const primary = run(withCandles, FROZEN_CONFIG_1H);
  console.log('\n-- per event (1h, gate 1.0%) --');
  for (const { event, result } of primary) {
    console.log(`${event.date} ${event.ticker.padEnd(5)} ${event.timing} ${result.state.padEnd(10)} ` +
      `${result.side ?? '-'} R=${fmt(result.r, 2)} ${result.exitReason ?? result.reason ?? ''}` +
      `${result.overshootR !== undefined ? ` over=${fmt(result.overshootR, 2)}R` : ''}`);
  }
  report('PRIMARY: 1h candles, gate 1.0%, 9 bps per side', primary);
  splitBy('timing', primary, (e) => e.timing);
  splitBy('coin', primary, (e) => e.ticker);
  splitBy('season', primary, (e) => e.date.slice(0, 7));

  report('SENSITIVITY (non-binding): gate 1.5%', run(withCandles, { ...FROZEN_CONFIG_1H, gatePct: 0.015 }));

  const cfg15: ReplayConfig = { ...FROZEN_CONFIG_1H, intervalMs: 900_000, leadMs: 900_000 };
  const with15: EventsWithCandles[] = [];
  for (const coin of coins) {
    const c15 = await candlesFor(coin, '15m');
    for (const event of file.events.filter((e) => e.coin === coin)) with15.push({ event, candles: c15 });
  }
  const r15 = run(with15, cfg15).filter((r) => r.result.state !== 'ineligible');
  report('SENSITIVITY (non-binding): 15m candles, only events the 15m history covers', r15);
  const same = primary.filter((p) => r15.some((r) => r.event === p.event));
  report('  same events on 1h for comparison', same);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
