/** Read-only event-straddle exit comparison. Requires configured Supabase reads and HL candles. */
import { ECONOMIC_EVENTS } from '@/lib/skills/economic-events';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { listLaddersWithRungs } from '@/lib/ladder/ladder-service';
import { outcomeFires } from '@/lib/ladder/ladder-outcome-service';
import type { LadderWithRungs } from '@/lib/ladder/ladder-types';
import {
  firstTrigger, pairedSummary, simulateStraddleExit,
  type PairedReturn, type ShadowCandle, type ShadowInput, type ShadowPolicy, type ShadowResult,
} from '@/lib/backtest/straddle-exit-shadow-business-logic';

const HOUR = 3_600_000;
const BAR = 15 * 60_000;
type Event = { name: string; printAt: number; legs: LadderWithRungs[] };

function printTime(ladder: LadderWithRungs): number | null {
  const match = ladder.thesis?.match(/\bprint (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/);
  if (match) return Date.parse(match[1]);
  if (ladder.expiresAt) return Date.parse(ladder.expiresAt) - 24 * HOUR;
  return null;
}

function collectEvents(ladders: LadderWithRungs[]): Event[] {
  const events = new Map<number, Event>();
  for (const event of ECONOMIC_EVENTS) {
    const printAt = Date.parse(event.atIso);
    events.set(printAt, { name: event.name, printAt, legs: [] });
  }
  for (const ladder of ladders) {
    if (!/straddle/i.test(ladder.title) || !ladder.rungs.some((rung) => rung.action === 'open')) continue;
    const printAt = printTime(ladder);
    if (printAt == null || !Number.isFinite(printAt)) continue;
    const nearby = [...events.keys()].find((at) => Math.abs(at - printAt) <= BAR);
    const key = nearby ?? printAt;
    const event = events.get(key) ?? { name: ladder.title.replace(/\s+[—-]\s+(long|short) leg.*$/i, ''), printAt: key, legs: [] };
    event.legs.push(ladder);
    events.set(key, event);
  }
  return [...events.values()].sort((a, b) => a.printAt - b.printAt);
}

function geometry(leg: LadderWithRungs): { side: 'long' | 'short'; gate: number; stop: number } | null {
  const open = leg.rungs.find((rung) => rung.action === 'open');
  if (!open || open.triggerPx == null) return null;
  const match = leg.thesis?.match(/Pre-print reference ([\d.]+)/);
  const ref = match ? Number(match[1]) : NaN;
  const side = open.side;
  const stop = open.stopPx ?? (Number.isFinite(ref) ? ref : NaN);
  return Number.isFinite(stop) ? { side, gate: open.triggerPx, stop } : null;
}

function reference(bars: ShadowCandle[], printAt: number): number | null {
  const before = bars.filter((bar) => bar.timestamp < printAt).at(-1);
  return before?.close ?? null;
}

function fmt(value: number | null): string { return value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`; }
function resultCell(result: ShadowResult | null): string {
  if (!result) return '—';
  return `${fmt(result.r)}${result.state === 'open' ? '*' : result.state === 'unavailable' ? '?' : ''}`;
}

async function candles(coin: string, printAt: number, now: number): Promise<ShadowCandle[] | null> {
  const end = Math.min(now, printAt + 7 * 24 * HOUR);
  const result = await fetchCandles(coin, '15m', printAt - HOUR, end);
  if (result.error || result.stale || result.candles.length < 2) {
    console.error(`${coin} ${new Date(printAt).toISOString()}: candle data unavailable: ${result.error ?? 'insufficient candles'}`);
    return null;
  }
  return result.candles;
}

async function main(): Promise<void> {
  const now = Date.now();
  // These service calls only SELECT. The script does not import arm, fire or upsert paths.
  const [active, archived] = await Promise.all([
    listLaddersWithRungs(), listLaddersWithRungs(undefined, { archived: true }),
  ]);
  const events = collectEvents([...active, ...archived]);
  const ids = events.flatMap((event) => event.legs.map((leg) => leg.id));
  const fires = await outcomeFires(ids);
  const variants = ['48h', 'trail-only', 'no-1r', 'ETH'] as const;
  const pairs = new Map<string, PairedReturn[]>(variants.map((variant) => [variant, []]));
  console.log('Event | Variant | Template R | Variant R | Difference R | Status');
  console.log('--- | --- | ---: | ---: | ---: | ---');
  for (const event of events) {
    const label = `${new Date(event.printAt).toISOString().slice(0, 16)} ${event.name}`;
    if (event.printAt > now) {
      for (const variant of variants) console.log(`${label} | ${variant} | — | — | — | future`);
      continue;
    }
    const btc = await candles('BTC', event.printAt, now);
    const btcLegs = event.legs.map(geometry).filter((value): value is NonNullable<typeof value> => value !== null);
    const long = btcLegs.find((leg) => leg.side === 'long');
    const short = btcLegs.find((leg) => leg.side === 'short');
    const ref = btc ? reference(btc, event.printAt) : null;
    const longGate = long?.gate ?? (ref == null ? null : ref * 1.01);
    const shortGate = short?.gate ?? (ref == null ? null : ref * 0.99);
    const actualOpens = fires.filter((fire) => fire.status === 'filled' && event.legs.some((leg) =>
      leg.id === fire.ladderId && leg.rungs.some((rung) => rung.id === fire.rungId && rung.action === 'open' && rung.coin === 'BTC')))
      .sort((a, b) => a.firedAt - b.firedAt);
    const fired = actualOpens[0];
    const firedLeg = fired ? event.legs.find((leg) => leg.id === fired.ladderId) : null;
    const firedSide = firedLeg?.rungs.find((rung) => rung.id === fired?.rungId)?.side;
    const historicalTrigger = firedSide && fired && btc?.some((bar) => bar.timestamp >= fired.firedAt)
      ? { side: firedSide, entryAt: Math.ceil(fired.firedAt / BAR) * BAR } : null;
    const triggered = historicalTrigger ?? (btc && longGate != null && shortGate != null
      ? firstTrigger(btc, event.printAt, longGate, shortGate) : null);
    let input: ShadowInput | null = null;
    if (btc && triggered && ref != null) {
      const leg = triggered.side === 'long' ? long : short;
      const gate = leg?.gate ?? (triggered.side === 'long' ? longGate : shortGate);
      const stop = leg?.stop ?? ref;
      const selectedLadder = firedLeg ?? event.legs.find((item) => item.rungs.some((rung) => rung.action === 'open' && rung.side === triggered.side && rung.coin === 'BTC'));
      const stallIds = new Set(selectedLadder?.rungs.filter((rung) => rung.action === 'reduce' && rung.triggerKind === 'indicator').map((rung) => rung.id) ?? []);
      const stallAt = fires.filter((fire) => fire.ladderId === selectedLadder?.id && stallIds.has(fire.rungId) && fire.status === 'filled')
        .map((fire) => Math.floor(fire.firedAt / BAR) * BAR - BAR);
      const rungs = selectedLadder?.rungs ?? [];
      const at = (seq: number): number | null => rungs.find((rung) => rung.seq === seq)?.triggerPx ?? null;
      const distance = Math.abs((gate ?? stop) - stop);
      const levels = gate != null ? {
        breakeven: at(2) ?? gate + (triggered.side === 'long' ? 0.7 : -0.7) * distance,
        first: at(3) ?? gate + (triggered.side === 'long' ? 1 : -1) * distance,
        second: at(4) ?? gate + (triggered.side === 'long' ? 2 : -2) * distance,
        trail: at(5) ?? gate + (triggered.side === 'long' ? 1.2 : -1.2) * distance,
        trailDistance: rungs.find((rung) => rung.seq === 5)?.triggerMeta?.trailDistancePx ?? gate * 0.01 * 0.8,
      } : undefined;
      if (gate != null) input = { side: triggered.side, gate, stop, printAt: event.printAt, entryAt: triggered.entryAt,
        candles: btc, stallAt, levels };
    }
    const template = input ? simulateStraddleExit(input, 'template') : null;
    for (const variant of variants) {
      let output: ShadowResult | null = null;
      if (variant === 'ETH') {
        const eth = await candles('ETH', event.printAt, now);
        const ethRef = eth ? reference(eth, event.printAt) : null;
        const ethTrigger = eth && ethRef != null
          ? firstTrigger(eth, event.printAt, ethRef * 1.01, ethRef * 0.99) : null;
        if (eth && ethRef != null && ethTrigger) {
          output = simulateStraddleExit({ side: ethTrigger.side, gate: ethRef * (ethTrigger.side === 'long' ? 1.01 : 0.99),
            stop: ethRef, printAt: event.printAt, entryAt: ethTrigger.entryAt, candles: eth }, 'template');
        }
      } else if (input) output = simulateStraddleExit(input, variant as ShadowPolicy);
      const complete = template?.state === 'closed' && output?.state === 'closed';
      const diff = template?.r != null && output?.r != null ? output.r - template.r : null;
      const status = complete ? (fired ? 'paired' : 'hypothetical') : !input ? 'no BTC trigger/data' : output?.state === 'unavailable' || !output ? 'no variant trigger/data' : 'provisional';
      console.log(`${label} | ${variant} | ${resultCell(template)} | ${resultCell(output)} | ${fmt(diff)} | ${status}`);
      if (complete && fired && template?.r != null && output?.r != null) pairs.get(variant)?.push({ event: label, template: template.r, variant: output.r });
    }
  }
  console.log('\nVariant | Paired events n | Mean ΔR | Bootstrap 95% CI | Worst event ΔR | Rule');
  console.log('--- | ---: | ---: | --- | ---: | ---');
  for (const variant of variants) {
    const summary = pairedSummary(pairs.get(variant) ?? []);
    const ci = summary.ci95 ? `[${fmt(summary.ci95[0])}, ${fmt(summary.ci95[1])}]` : '—';
    console.log(`${variant} | ${summary.n} | ${fmt(summary.meanDifference)} | ${ci} | ${fmt(summary.worstDifference)} | ${summary.adopt ? 'eligible' : 'hold'}`);
  }
  console.log('\n* Open residual: R includes a mark, not a realised exit. Missing stall fires mean candle-only replay omits that rung.');
}

main().catch((error: unknown) => {
  console.error('shadow-straddle-exits failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
