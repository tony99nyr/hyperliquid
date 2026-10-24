/** Pure historical replay of the frozen daily htf-trend rule. No live trading imports. */
import { htfTrendExitHit, htfTrendRead, type HtfTrendBreakout } from '@/lib/scout/htf-trend-signal-business-logic';
import { mean, mulberry32, percentile } from './significance-business-logic';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const EPISODE = 5 * DAY;
const OVERSHOOT = 0.0016;
const TAKER = 0.00045;
const MAJORS = new Set(['BTC', 'ETH', 'SOL', 'HYPE']);

export interface ReplayBar { time: number; open: number; high: number; low: number; close: number }
export interface ReplayFunding { time: number; fundingHourly: number }
export interface ReplayListing { coin: string; from: number; to: number }
export interface ReplayInput { coin: string; listing: ReplayListing; bars: ReplayBar[]; funding: ReplayFunding[] }
export interface ReplayTrade {
  coin: string; side: 'long' | 'short'; entryTime: number; exitTime: number;
  entryPx: number; exitPx: number; stopPx: number; fundingFraction: number; netR: number;
  exitReason: 'stop' | 'channel';
}
export interface ReplayResult { trades: ReplayTrade[]; blockedByCap: number; openAtEnd: number }

interface Position { side: 'long' | 'short'; entryTime: number; entryPx: number; stopPx: number }
interface CoinState {
  input: ReplayInput; bars: ReplayBar[]; index: number; position: Position | null;
  pendingEntry: HtfTrendBreakout | null; pendingExit: boolean;
}

function checkInput(input: ReplayInput): ReplayBar[] {
  if (input.coin !== input.listing.coin || !Number.isFinite(input.listing.from) ||
    !Number.isFinite(input.listing.to) || input.listing.to <= input.listing.from) {
    throw new Error(`Invalid listing for ${input.coin}`);
  }
  const bars = input.bars.filter((bar) => bar.time >= input.listing.from && bar.time < input.listing.to);
  bars.sort((a, b) => a.time - b.time);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (![b.time, b.open, b.high, b.low, b.close].every(Number.isFinite) ||
      b.open <= 0 || b.low <= 0 || b.low > Math.min(b.open, b.close) ||
      b.high < Math.max(b.open, b.close) || (i > 0 && b.time - bars[i - 1].time !== DAY)) {
      throw new Error(`Invalid or missing daily candle for ${input.coin} at ${b.time}`);
    }
  }
  for (let i = 1; i < input.funding.length; i++) {
    if (input.funding[i].time <= input.funding[i - 1].time ||
      !Number.isFinite(input.funding[i].fundingHourly)) throw new Error(`Invalid funding for ${input.coin}`);
  }
  return bars;
}

function fundingDuring(points: ReplayFunding[], start: number, end: number, coin: string): number {
  if (end <= start) return 0;
  const rows = points.filter((p) => p.time > start && p.time <= end);
  // HL settles hourly. A gap makes a net-R claim unsafe; do not silently use zero.
  const expected = Math.floor((end - start) / HOUR);
  if (rows.length !== expected || rows.some((p, i) => p.time !== start + (i + 1) * HOUR)) {
    throw new Error(`Missing hourly funding for ${coin} from ${start} to ${end}`);
  }
  return rows.reduce((sum, p) => sum + p.fundingHourly, 0);
}

function adversePx(raw: number, side: 'long' | 'short', entry: boolean): number {
  const sign = side === 'long' ? 1 : -1;
  return raw * (1 + (entry ? sign : -sign) * OVERSHOOT);
}

/** Replays every listed coin on one clock. Same-day entries use alphabetical priority. */
export function replayHtfPortfolio(inputs: ReplayInput[]): ReplayResult {
  const names = new Set<string>();
  const states = inputs.map((input): CoinState => {
    if (names.has(input.coin)) throw new Error(`Duplicate coin ${input.coin}`);
    names.add(input.coin);
    return { input, bars: checkInput(input), index: 0, position: null, pendingEntry: null, pendingExit: false };
  }).sort((a, b) => a.input.coin.localeCompare(b.input.coin));
  const times = [...new Set(states.flatMap((s) => s.bars.map((b) => b.time)))].sort((a, b) => a - b);
  const trades: ReplayTrade[] = [];
  let blockedByCap = 0;

  function close(s: CoinState, time: number, raw: number, reason: 'stop' | 'channel'): void {
    const p = s.position;
    if (!p) throw new Error('Closing a missing position');
    const exitPx = adversePx(raw, p.side, false);
    const direction = p.side === 'long' ? 1 : -1;
    const risk = Math.abs(p.entryPx - p.stopPx);
    const fundingFraction = fundingDuring(s.input.funding, p.entryTime, time, s.input.coin);
    const netR = (direction * (exitPx - p.entryPx) - TAKER * (p.entryPx + exitPx)
      - direction * fundingFraction * p.entryPx) / risk;
    trades.push({ coin: s.input.coin, side: p.side, entryTime: p.entryTime,
      exitTime: time, entryPx: p.entryPx, exitPx, stopPx: p.stopPx,
      fundingFraction, netR, exitReason: reason });
    s.position = null;
    s.pendingExit = false;
  }

  for (const time of times) {
    const today = states.filter((s) => s.bars[s.index]?.time === time);
    // First honour stops and pending exits for positions carried into this open.
    for (const s of today) {
      const bar = s.bars[s.index];
      const p = s.position;
      if (!p) continue;
      const gapStop = p.side === 'long' ? bar.open <= p.stopPx : bar.open >= p.stopPx;
      if (gapStop) close(s, time, bar.open, 'stop');
      else if (s.pendingExit) close(s, time, bar.open, 'channel');
    }
    // Then apply the shared portfolio cap to all entries at this open.
    for (const s of today) {
      const signal = s.pendingEntry;
      s.pendingEntry = null;
      if (!signal || s.position) continue;
      const coin = s.input.coin;
      const openMajors = states.filter((other) => other.position?.side === signal.side &&
        MAJORS.has(other.input.coin)).length;
      if (MAJORS.has(coin) && openMajors >= 2) { blockedByCap++; continue; }
      const entryPx = adversePx(s.bars[s.index].open, signal.side, true);
      if ((signal.side === 'long' && entryPx <= signal.stopPx) ||
        (signal.side === 'short' && entryPx >= signal.stopPx)) continue;
      s.position = { side: signal.side, entryTime: time, entryPx, stopPx: signal.stopPx };
    }
    // A hard stop can fill within this bar. A close-channel signal waits for tomorrow.
    for (const s of today) {
      const bar = s.bars[s.index];
      const p = s.position;
      if (p) {
        const stopHit = p.side === 'long' ? bar.low <= p.stopPx : bar.high >= p.stopPx;
        if (stopHit) close(s, time + DAY, p.stopPx, 'stop');
      }
      const read = htfTrendRead(s.bars.slice(0, s.index + 1).map((b) => ({
        highPx: b.high, lowPx: b.low, closePx: b.close,
      })));
      if (read && s.position) s.pendingExit = htfTrendExitHit(read, s.position.side);
      else if (read && !s.position) s.pendingEntry = read.breakout;
      s.index++;
    }
  }
  trades.sort((a, b) => a.entryTime - b.entryTime || a.coin.localeCompare(b.coin));
  return { trades, blockedByCap, openAtEnd: states.filter((s) => s.position).length };
}

function episodeKey(time: number): number { return Math.floor(time / EPISODE); }
function episodes(trades: ReplayTrade[]): ReplayTrade[][] {
  const groups = new Map<number, ReplayTrade[]>();
  for (const trade of trades) {
    const key = episodeKey(trade.entryTime);
    const group = groups.get(key) ?? [];
    group.push(trade);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export interface ReplaySummary {
  n: number; episodes: number; meanR: number; ciLow: number; ciHigh: number;
  pEdgePositive: number; folds: { year: number; n: number; meanR: number }[];
}

export function summariseHtfReplay(trades: ReplayTrade[], iterations = 10_000, seed = 20261024): ReplaySummary {
  if (!trades.length || iterations < 1) throw new Error('Need trades and positive iterations');
  const blocks = episodes(trades);
  const rng = mulberry32(seed);
  const draws: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[Math.floor(rng() * blocks.length)];
      sum += block.reduce((v, trade) => v + trade.netR, 0);
      n += block.length;
    }
    draws.push(sum / n);
  }
  draws.sort((a, b) => a - b);
  const years = [...new Set(trades.map((t) => new Date(t.entryTime).getUTCFullYear()))].sort();
  return { n: trades.length, episodes: blocks.length, meanR: mean(trades.map((t) => t.netR)),
    ciLow: percentile(draws, 0.025), ciHigh: percentile(draws, 0.975),
    pEdgePositive: draws.filter((x) => x > 0).length / iterations,
    folds: years.map((year) => {
      const rs = trades.filter((t) => new Date(t.entryTime).getUTCFullYear() === year).map((t) => t.netR);
      return { year, n: rs.length, meanR: mean(rs) };
    }) };
}

/** Largest rolling 5-day entry cluster, matching the registered forward check. */
export function forwardBarPass(sample: { time: number; r: number }[]): boolean {
  if (sample.length !== 20) return false;
  const raw = mean(sample.map((x) => x.r));
  if (raw < 0.25 || raw * 0.7 <= 0) return false;
  let bestSum = -Infinity;
  let bestStart = 0;
  for (const anchor of sample) {
    const sum = sample.filter((x) => x.time >= anchor.time && x.time < anchor.time + EPISODE)
      .reduce((v, x) => v + x.r, 0);
    if (sum > bestSum) { bestSum = sum; bestStart = anchor.time; }
  }
  const rest = sample.filter((x) => x.time < bestStart || x.time >= bestStart + EPISODE);
  return rest.length > 0 && mean(rest.map((x) => x.r)) >= 0.25;
}

export interface ForwardBarSimulation { iterations: number; zeroEdgePasses: number; estimatedEdgePasses: number;
  pPassZeroEdge: number; pPassEstimatedEdge: number }

export function simulateForwardBar(trades: ReplayTrade[], iterations = 10_000, seed = 20261025): ForwardBarSimulation {
  if (!trades.length || iterations < 1) throw new Error('Need trades and positive iterations');
  const blocks = episodes(trades);
  const centre = mean(trades.map((t) => t.netR));
  const rng = mulberry32(seed);
  let zeroEdgePasses = 0;
  let estimatedEdgePasses = 0;
  for (let i = 0; i < iterations; i++) {
    const sample: { time: number; r: number }[] = [];
    let draw = 0;
    while (sample.length < 20) {
      const block = blocks[Math.floor(rng() * blocks.length)];
      const first = Math.min(...block.map((t) => t.entryTime));
      for (const trade of block) {
        if (sample.length === 20) break;
        sample.push({ time: draw * EPISODE + trade.entryTime - first, r: trade.netR });
      }
      draw++;
    }
    if (forwardBarPass(sample)) estimatedEdgePasses++;
    if (forwardBarPass(sample.map((x) => ({ ...x, r: x.r - centre })))) zeroEdgePasses++;
  }
  return { iterations, zeroEdgePasses, estimatedEdgePasses,
    pPassZeroEdge: zeroEdgePasses / iterations, pPassEstimatedEdge: estimatedEdgePasses / iterations };
}
