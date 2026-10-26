/**
 * Read-only spot-perp carry study. See docs/scout/PREREGISTRATION_spot-perp-carry.md.
 * HL info only, through _study-io. Never trades. Output goes to stdout.
 */
import path from 'node:path';
import { cachedJson, hlFundingHistory, hlInfo, loadStudyEnv, STUDY_CACHE_ROOT } from './_study-io';
import { parseCandleSnapshot } from '@/lib/hyperliquid/candle-service-business-logic';
import {
  basketEquity, carryVerdict, marginForRally, PREREGISTERED_PARAMS, replaySpotPerpCarry, summariseCarry,
  type CarryCandle, type CarryRun,
} from '@/lib/backtest/spot-perp-carry-business-logic';

const CACHE = path.join(STUDY_CACHE_ROOT, 'spot-perp-carry');
const HOUR = 3_600_000;
const COINS = ['BTC', 'ETH', 'HYPE', 'SOL'];
/** Spot token names on HL for each perp. */
const SPOT_TOKEN: Record<string, string[]> = { BTC: ['UBTC'], ETH: ['UETH'], HYPE: ['HYPE'], SOL: ['USOL'] };
const STEP = 4 * HOUR;
const STEP_LABEL = '4h';
const PARAMS = { ...PREREGISTERED_PARAMS, stepMs: STEP };
const STUDY_START = Date.UTC(2023, 0, 1);
const CACHE_AGE = 6 * HOUR;

interface SpotMeta { tokens: Array<{ name: string; index: number }>; universe: Array<{ name: string; tokens: number[]; index: number }> }
interface PerpMeta { universe: Array<{ name: string; maxLeverage: number }> }

/** HL serves only the most recent 5000 candles per request and per series, so one window is all there is. */
async function recentCandles(coin: string, end: number): Promise<CarryCandle[]> {
  const startTime = Math.max(STUDY_START, end - 4990 * STEP);
  console.error(`candles ${coin} ${new Date(startTime).toISOString()}`);
  const rows = parseCandleSnapshot(await hlInfo<unknown>({
    type: 'candleSnapshot', req: { coin, interval: STEP_LABEL, startTime, endTime: end } }));
  return rows.map((c) => ({ timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Amendment 2 data rule: early spot prints can be pre-market placeholders (UBTC printed 6969696 for days).
 * A spot candle is valid only if its open is within 10% of the perp open in the same bucket. The series
 * starts at the first valid candle that begins a run of 42 valid candles (7 days of 4h). Later invalid
 * candles are dropped (treated as missing).
 */
export function cleanSpot(spot: CarryCandle[], perp: CarryCandle[]): { clean: CarryCandle[]; droppedEarly: number; droppedLate: number } {
  const perpOpen = new Map(perp.map((c) => [c.timestamp, c.open]));
  const valid = spot.map((c) => { const q = perpOpen.get(c.timestamp); return q !== undefined && Math.abs(c.open / q - 1) <= 0.1; });
  let start = -1;
  for (let i = 0; i + 42 <= spot.length && start < 0; i++) if (valid.slice(i, i + 42).every(Boolean)) start = i;
  if (start < 0) return { clean: [], droppedEarly: spot.length, droppedLate: 0 };
  const tail = spot.slice(start).filter((_, i) => valid[start + i]);
  return { clean: tail, droppedEarly: start, droppedLate: spot.length - start - tail.length };
}

const pct = (x: number | null, d = 2) => (x === null || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const date = (t: number) => new Date(t).toISOString().slice(0, 10);

function report(label: string, run: { times: number[]; equity: number[] }, hoursInMarket: number, trips: number): string[] {
  const m = summariseCarry(run.times, run.equity, hoursInMarket, trips);
  const v = carryVerdict(m);
  return [
    `${label}: ${v.verdict} (${v.reasons.join('; ')})`,
    `  coverage ${date(run.times[0] ?? 0)}..${date(run.times.at(-1) ?? 0)} (${m.days.toFixed(0)} d), years with data ${m.yearsWithData}, positive ${m.yearsPositive}`,
    `  net APR ${pct(m.netApr)} | total ${pct(m.totalReturn)} | worst 30d ${pct(m.worst30d)} | time in market ${pct(m.timeInMarket, 1)} | round trips ${trips}`,
    `  by year: ${m.yearPnl.map((y) => `${y.year}${y.counted ? '' : '*'} ${pct(y.pnl)} (${y.days.toFixed(0)}d)`).join(', ')}  (* under 60 d, not counted)`,
  ];
}

async function main(): Promise<void> {
  loadStudyEnv();
  const end = Date.now();
  const spotMeta = await cachedJson(CACHE, 'spotMeta.json', () => hlInfo<SpotMeta>({ type: 'spotMeta' }), CACHE_AGE);
  const perpMeta = await cachedJson(CACHE, 'meta.json', () => hlInfo<PerpMeta>({ type: 'meta' }), CACHE_AGE);
  const lines: string[] = [`spot-perp-carry replay, run ${new Date(end).toISOString()}`, ''];
  const runs: Array<{ coin: string; run: CarryRun; ref: CarryRun }> = [];

  for (const coin of COINS) {
    const tokenNames = SPOT_TOKEN[coin];
    const usdc = spotMeta.tokens.find((t) => t.name === 'USDC')?.index;
    const token = spotMeta.tokens.find((t) => tokenNames.includes(t.name));
    const pair = token && usdc !== undefined
      ? spotMeta.universe.find((u) => u.tokens[0] === token.index && u.tokens[1] === usdc) : undefined;
    if (!pair) { lines.push(`${coin}: no spot market in spotMeta (looked for ${tokenNames.join('/')}), excluded`, ''); continue; }
    const spotName = `@${pair.index}`;
    const maxLev = perpMeta.universe.find((u) => u.name === coin)?.maxLeverage ?? 20;
    const rawSpot = await cachedJson(CACHE, `spot-${coin}.json`, () => recentCandles(spotName, end), CACHE_AGE);
    const perp = await cachedJson(CACHE, `perp-${coin}.json`, () => recentCandles(coin, end), CACHE_AGE);
    const cleaned = cleanSpot(rawSpot, perp);
    const spot = cleaned.clean;
    const funding = await cachedJson(CACHE, `funding-${coin}.json`, () => hlFundingHistory(coin, STUDY_START, end), CACHE_AGE);
    lines.push(`${coin}: spot ${spotName} (${pair.name}), first raw spot candle ${rawSpot.length ? date(rawSpot[0].timestamp) : 'none'}, first clean ${spot.length ? date(spot[0].timestamp) : 'none'} (dropped early ${cleaned.droppedEarly}, late ${cleaned.droppedLate}), `
      + `${rawSpot.length} spot / ${perp.length} perp ${STEP_LABEL} candles, ${funding.length} funding rows, perp maxLeverage ${maxLev}`);
    const run = replaySpotPerpCarry(funding, spot, perp, PARAMS);
    const ref = replaySpotPerpCarry(funding, spot, perp, { ...PARAMS, useSignal: false });
    runs.push({ coin, run, ref });
    if (!run.times.length) { lines.push('  no replay hours', ''); continue; }

    lines.push(...report(`${coin} PRIMARY`, run, run.hoursInMarket, run.trades.length));
    lines.push(...report(`${coin} reference always-on (non-binding)`, ref, ref.hoursInMarket, 1).slice(0, 1 + 2));
    const fees = run.trades.reduce((a, t) => a + t.feesPaid, 0);
    const fund = run.trades.reduce((a, t) => a + t.fundingEarned, 0);
    const basis = run.trades.reduce((a, t) => a + t.basisPnl, 0);
    const worstRally = Math.max(0, ...run.trades.map((t) => t.maxRally));
    const mm = 1 / (2 * maxLev);
    const need = marginForRally(0.3, PREREGISTERED_PARAMS.perpLeverage, mm);
    lines.push(`  attribution per 1.0 notional: funding ${fund.toFixed(4)}, fees -${fees.toFixed(4)}, basis ${basis.toFixed(4)}; hours waiting for a candle open ${run.deferredEntries}`);
    lines.push(`  margin, 30% rally at 3x (mm ${pct(mm)}): perp equity left ${need.equityLeft.toFixed(3)} of N0, top-up to 3x ${need.topUpToLeverage.toFixed(3)}, `
      + `top-up to maintenance ${need.topUpToMaintenance.toFixed(3)}, isolated liquidation at +${pct(need.liquidationRally, 1)}`);
    lines.push(`  largest rally from entry inside any held trade: +${pct(worstRally, 1)}`, '');
  }

  const used = runs.filter((r) => r.run.times.length);
  if (used.length >= 2) {
    const basket = basketEquity(used.map((r) => r.run));
    lines.push(...report(`BASKET equal weight (${used.map((r) => r.coin).join(', ')})`, basket,
      used.reduce((a, r) => a + r.run.hoursInMarket, 0) / used.length, used.reduce((a, r) => a + r.run.trades.length, 0)));
    const ref = basketEquity(used.map((r) => r.ref));
    lines.push(...report('BASKET reference always-on (non-binding)', ref, NaN, 0).slice(0, 3));
  } else lines.push('BASKET: INSUFFICIENT (fewer than 2 coins with a spot market and data)');
  console.log(lines.join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
