/**
 * Shared library for the perp-follow study: fill fetching (cached), round-trip
 * construction, per-window metric computation, funding application, and the
 * regime-gate adapter over OUR detector on OUR HL daily ETH/BTC candles.
 */
import * as fs from 'fs';
import { PATHS } from './study-config';

// ---------------------------------------------------------------------------
// Fills: cache + fetch
// ---------------------------------------------------------------------------
export interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: 'B' | 'A'; // Buy / Ask(sell)
  time: number;
  startPosition: string;
  dir: string; // "Open Long" | "Close Long" | "Buy" | "Sell" | ...
  closedPnl: string;
  fee: string;
  feeToken?: string;
}

const FILLS_DIR_NEW = `${PATHS.OUT_DIR}/fills`;
const FILLS_DIR_OLD = `${PATHS.HL_DIR}/fills`;

export function cachedFillsPath(addr: string): string | null {
  const a = addr.toLowerCase();
  const pNew = `${FILLS_DIR_NEW}/${a}.json`;
  const pOld = `${FILLS_DIR_OLD}/${a}.json`;
  if (fs.existsSync(pNew)) return pNew;
  if (fs.existsSync(pOld)) return pOld;
  return null;
}

export function loadCachedFills(addr: string): Fill[] | null {
  const p = cachedFillsPath(addr);
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Fill[];
  } catch {
    return null;
  }
}

let lastFillReq = 0;
const FILL_SPACING_MS = 250; // global gate (tuned: 35/90ms tripped HL weight-limit 429; 250ms sustainable)
export async function fetchFillsByTime(addr: string, startTime: number, endTime?: number): Promise<Fill[]> {
  // Paginate forward (2000/page). Endpoint retains only most-recent ~12k fills.
  const all: Fill[] = [];
  let cursor = startTime;
  let retryBudget = 8; // global cap across all pages — prevents infinite 429 loops
  for (let page = 0; page < 7; page++) {
    const wait = lastFillReq + FILL_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFillReq = Date.now();
    const body: Record<string, unknown> = { type: 'userFillsByTime', user: addr, startTime: cursor };
    if (endTime) body.endTime = endTime;
    let res: Response;
    try {
      res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (retryBudget-- <= 0) break;
      await new Promise((r) => setTimeout(r, 1500));
      page--;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (retryBudget-- <= 0) break;
      await new Promise((r) => setTimeout(r, 1000 + (8 - retryBudget) * 800));
      page--;
      continue;
    }
    if (!res.ok) break;
    const batch = (await res.json()) as Fill[];
    if (!batch.length) break;
    all.push(...batch);
    const last = batch[batch.length - 1].time;
    if (batch.length < 2000 || last <= cursor) break;
    cursor = last + 1;
  }
  // dedupe by time+coin+px+sz
  const seen = new Set<string>();
  const out: Fill[] = [];
  for (const f of all) {
    const k = `${f.time}|${f.coin}|${f.px}|${f.sz}|${f.dir}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

export function saveFills(addr: string, fills: Fill[]): void {
  fs.mkdirSync(FILLS_DIR_NEW, { recursive: true });
  fs.writeFileSync(`${FILLS_DIR_NEW}/${addr.toLowerCase()}.json`, JSON.stringify(fills));
}

// ---------------------------------------------------------------------------
// Round-trip construction
// ---------------------------------------------------------------------------
export interface RoundTrip {
  coin: string;
  openTime: number;
  closeTime: number;
  side: 'long' | 'short';
  entryNotional: number; // |entry size| * avg entry px
  realizedPnl: number; // sum of closedPnl on closing fills minus fees attributable
  win: boolean;
}

/**
 * Walk fills for ONE coin, time-ordered, tracking signed net position.
 * A round-trip = position leaves flat and returns to flat (or sign-flips through 0).
 * realizedPnl = sum of closedPnl over the trip's fills - sum(fees) over the trip.
 */
export function buildRoundTripsForCoin(fills: Fill[], coin: string): RoundTrip[] {
  const f = fills.filter((x) => x.coin === coin).sort((a, b) => a.time - b.time);
  const trips: RoundTrip[] = [];
  let pos = 0; // signed size
  let tripOpenTime = 0;
  let tripClosedPnl = 0;
  let tripFees = 0;
  let tripEntryNotional = 0;
  let tripSide: 'long' | 'short' | null = null;

  for (const x of f) {
    const sz = parseFloat(x.sz);
    const px = parseFloat(x.px);
    const fee = parseFloat(x.fee || '0');
    const cpnl = parseFloat(x.closedPnl || '0');
    const signed = x.side === 'B' ? sz : -sz; // buy adds, sell subtracts
    const prevPos = pos;
    pos = prevPos + signed;

    if (prevPos === 0 && pos !== 0) {
      // opening a new trip
      tripOpenTime = x.time;
      tripClosedPnl = 0;
      tripFees = fee;
      tripEntryNotional = Math.abs(signed) * px;
      tripSide = pos > 0 ? 'long' : 'short';
    } else if (prevPos !== 0 && Math.sign(pos) === Math.sign(prevPos) && pos !== 0) {
      // same-direction add or partial reduce
      tripFees += fee;
      tripClosedPnl += cpnl;
      if (Math.abs(pos) > Math.abs(prevPos)) tripEntryNotional += Math.abs(signed) * px; // adding
    } else {
      // crossed or hit flat: close current trip
      tripFees += fee;
      tripClosedPnl += cpnl;
      if (tripSide) {
        const pnl = tripClosedPnl - tripFees;
        trips.push({
          coin,
          openTime: tripOpenTime,
          closeTime: x.time,
          side: tripSide,
          entryNotional: tripEntryNotional,
          realizedPnl: pnl,
          win: pnl > 0,
        });
      }
      if (pos !== 0) {
        // sign-flipped through zero: a new trip opened by the residual
        tripOpenTime = x.time;
        tripClosedPnl = 0;
        tripFees = 0;
        tripEntryNotional = Math.abs(pos) * px;
        tripSide = pos > 0 ? 'long' : 'short';
      } else {
        tripSide = null;
      }
    }
  }
  return trips;
}

export function buildAllRoundTrips(fills: Fill[]): RoundTrip[] {
  const coins = [...new Set(fills.map((f) => f.coin))];
  const out: RoundTrip[] = [];
  for (const c of coins) out.push(...buildRoundTripsForCoin(fills, c));
  out.sort((a, b) => a.closeTime - b.closeTime);
  return out;
}

// ---------------------------------------------------------------------------
// Metrics over a set of round-trips
// ---------------------------------------------------------------------------
export interface MetricSet {
  nTrips: number;
  winRate: number;
  rawPnl: number;
  avgWin: number;
  avgLoss: number; // positive magnitude
  profitFactor: number; // sum wins / |sum losses|
  perTradeSharpe: number; // mean(r)/std(r) on per-trade return = pnl/entryNotional
  perTradeSortino: number;
  maxDrawdownFrac: number; // on cumulative pnl path vs peak (frac of peak equity proxy)
  calmar: number; // rawPnl-based: totalReturn / maxDD
  worstLoss: number; // magnitude of worst single round-trip loss
  blowUp: boolean;
  medianEntryNotional: number;
}

export function computeMetrics(trips: RoundTrip[], avgAccountValue: number | null): MetricSet {
  const n = trips.length;
  const pnls = trips.map((t) => t.realizedPnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const sumWins = wins.reduce((a, b) => a + b, 0);
  const sumLoss = -losses.reduce((a, b) => a + b, 0); // positive
  const rawPnl = pnls.reduce((a, b) => a + b, 0);
  const winRate = n ? wins.length / n : 0;
  const avgWin = wins.length ? sumWins / wins.length : 0;
  const avgLoss = losses.length ? sumLoss / losses.length : 0;
  const profitFactor = sumLoss > 0 ? sumWins / sumLoss : (sumWins > 0 ? Infinity : 0);

  // per-trade returns
  const rets = trips.map((t) => (t.entryNotional > 0 ? t.realizedPnl / t.entryNotional : 0));
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const variance = rets.length > 1 ? rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1) : 0;
  const sd = Math.sqrt(variance);
  const downside = rets.filter((r) => r < 0);
  const dsd = downside.length ? Math.sqrt(downside.reduce((a, r) => a + r * r, 0) / downside.length) : 0;
  const perTradeSharpe = sd > 0 ? mean / sd : 0;
  const perTradeSortino = dsd > 0 ? mean / dsd : (mean > 0 ? Infinity : 0);

  // Drawdown on the cumulative PER-TRADE-RETURN equity curve (additive, scale-free).
  // We do NOT have account value for off-leaderboard wallets, so a return-based DD is
  // the honest, comparable basis: it answers "how deep a peak-to-trough in compounded
  // per-trade return did this book suffer". maxDrawdownFrac is in return units.
  let cumR = 0, peakR = 0, maxDDr = 0;
  for (const r of rets) {
    cumR += r;
    if (cumR > peakR) peakR = cumR;
    const dd = peakR - cumR;
    if (dd > maxDDr) maxDDr = dd;
  }
  const maxDrawdownFrac = maxDDr; // sum-of-returns drawdown (e.g. 0.5 = lost 50% of notional-normalized gains+capital)
  const totalReturn = rets.reduce((a, b) => a + b, 0); // sum of per-trade returns
  const calmar = maxDrawdownFrac > 0 ? totalReturn / maxDrawdownFrac : (totalReturn > 0 ? Infinity : 0);

  const worstLoss = losses.length ? -Math.min(...losses) : 0;
  const medWin = wins.length ? wins.slice().sort((a, b) => a - b)[Math.floor(wins.length / 2)] : 0;
  const medianEntryNotional = n
    ? trips.map((t) => t.entryNotional).sort((a, b) => a - b)[Math.floor(n / 2)]
    : 0;
  // Blow-up: a single round-trip loss > 2x the median win (martingale/no-stop signature),
  // OR a return-based drawdown exceeding 50% of notional (a full-size wipe of accumulated edge).
  const blowUp = (medWin > 0 && worstLoss > 2 * medWin) || maxDrawdownFrac > 0.5;

  return {
    nTrips: n,
    winRate,
    rawPnl,
    avgWin,
    avgLoss,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : 999,
    perTradeSharpe,
    perTradeSortino: Number.isFinite(perTradeSortino) ? perTradeSortino : 999,
    maxDrawdownFrac,
    calmar: Number.isFinite(calmar) ? calmar : 999,
    worstLoss,
    blowUp,
    medianEntryNotional,
  };
}
