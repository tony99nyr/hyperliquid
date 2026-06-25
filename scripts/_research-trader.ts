/**
 * _research-trader — one-off READ-ONLY profile of a single HL wallet.
 *
 * Pulls live clearinghouse + deep fill history from HL's PUBLIC info API and
 * reconstructs round-trips to answer: median hold (intraday?), profitability,
 * cadence/consistency, concentration (few coins vs many), and risk posture
 * (leverage, liquidations, drawdown, martingale adds). Nothing here trades.
 *
 *   pnpm tsx --tsconfig tsconfig.scripts.json scripts/_research-trader.ts 0x...
 */

import { fetchClearinghouseState, fetchAllFills, type HlFill } from '@/lib/hyperliquid/hyperliquid-info-service';
import { buildCopyMonitorAnalytics } from '@/lib/hyperliquid/copy-monitor-analytics';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EPS = 1e-9;

const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const dur = (ms: number) => {
  if (ms < HOUR) return `${(ms / 60000).toFixed(0)}m`;
  if (ms < DAY) return `${(ms / HOUR).toFixed(1)}h`;
  return `${(ms / DAY).toFixed(1)}d`;
};
const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

interface RoundTrip {
  coin: string;
  openTime: number;
  closeTime: number;
  holdMs: number;
  pnl: number;
  fills: number;
}

/** Reconstruct round-trips per coin by tracking signed running size across fills. */
function reconstructRoundTrips(fills: HlFill[]): { trips: RoundTrip[]; openByCoin: Map<string, number> } {
  const byCoin = new Map<string, HlFill[]>();
  for (const f of fills) {
    if (!byCoin.has(f.coin)) byCoin.set(f.coin, []);
    byCoin.get(f.coin)!.push(f);
  }
  const trips: RoundTrip[] = [];
  const openByCoin = new Map<string, number>(); // coin -> openTime still open at end
  for (const [coin, fs] of byCoin) {
    fs.sort((a, b) => a.time - b.time);
    let pos = 0;
    let openTime = 0;
    let pnlAccum = 0;
    let fillAccum = 0;
    for (const f of fs) {
      const delta = f.side === 'buy' ? f.sz : -f.sz;
      if (Math.abs(pos) < EPS && Math.abs(delta) > EPS) openTime = f.time; // opening from flat
      pnlAccum += f.closedPnl ?? 0;
      fillAccum += 1;
      const prev = pos;
      pos += delta;
      const crossedZero = Math.abs(pos) < EPS || prev * pos < 0; // hit flat or flipped sign
      if (crossedZero && openTime > 0) {
        trips.push({ coin, openTime, closeTime: f.time, holdMs: f.time - openTime, pnl: pnlAccum, fills: fillAccum });
        pnlAccum = 0;
        fillAccum = 0;
        openTime = Math.abs(pos) > EPS ? f.time : 0; // sign-flip reopens immediately
      }
    }
    if (Math.abs(pos) > EPS && openTime > 0) openByCoin.set(coin, openTime);
  }
  return { trips, openByCoin };
}

async function main() {
  const address = process.argv[2];
  if (!address) throw new Error('usage: _research-trader.ts <0xADDRESS>');

  console.log(`\n=== HL wallet research — ${address} ===`);
  console.log('Fetching live clearinghouse + deep fill history (public API, read-only)…\n');

  // HL's userFillsByTime walks FORWARD from sinceMs and page-caps; a hyperactive
  // wallet hits maxFills inside an early slice and never reaches recent activity.
  // So default to a RECENT window (last N days, arg #2) to characterize current
  // behavior; raise --max for completeness within it.
  const windowDays = Number(process.argv[3]) || 30;
  const sinceMs = Date.now() - windowDays * DAY;
  const [state, fillsRes] = await Promise.all([
    fetchClearinghouseState(address),
    fetchAllFills(address, { sinceMs, maxFills: 40000 }),
  ]);
  const fills = fillsRes.fills;
  console.log(`window: last ${windowDays}d`);

  // --- Completeness ---
  console.log('── DATA COMPLETENESS ──');
  console.log(`fills seen (last 365d): ${fills.length}${fillsRes.truncated ? '  ⚠️ TRUNCATED (hit bound — tail unseen)' : ' (history exhausted)'}`);
  if (fills.length < 50) console.log('⚠️ INSUFFICIENT_HISTORY — < 50 fills, too thin to grade confidently.');
  if (fills.length === 0) {
    console.log('No fills — nothing to profile.');
    return;
  }

  const { trips } = reconstructRoundTrips(fills);
  const firstT = Math.min(...fills.map((f) => f.time));
  const lastT = Math.max(...fills.map((f) => f.time));
  const span = Math.max(1, lastT - firstT);

  // --- Profitability ---
  const totalPnl = fills.reduce((s, f) => s + (f.closedPnl ?? 0), 0);
  const closedTrips = trips.filter((t) => t.holdMs >= 0);
  const wins = closedTrips.filter((t) => t.pnl > 0);
  const losses = closedTrips.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const medWin = median(wins.map((t) => t.pnl));
  const worstLoss = losses.length ? Math.min(...losses.map((t) => t.pnl)) : 0;

  console.log('\n── PROFITABILITY (realized, HL closedPnl; pre-fee) ──');
  console.log(`net realized PnL (365d): ${usd(totalPnl)}`);
  console.log(`round-trips: ${closedTrips.length}  |  win rate: ${closedTrips.length ? pct(wins.length / closedTrips.length) : 'n/a'}`);
  console.log(`profit factor: ${profitFactor === Infinity ? '∞ (no losers)' : profitFactor.toFixed(2)}  |  median win ${usd(medWin)}  worst loss ${usd(worstLoss)}`);
  console.log(`worst-loss / median-win: ${medWin > 0 ? (Math.abs(worstLoss) / medWin).toFixed(1) + '×' : 'n/a'} (high = many small wins, one big loss)`);

  // --- Hold time (intraday?) ---
  const holds = closedTrips.map((t) => t.holdMs);
  const medHold = median(holds);
  const intraday = closedTrips.filter((t) => t.holdMs < DAY).length;
  console.log('\n── HOLD TIME ──');
  console.log(`median hold: ${dur(medHold)}  |  mean hold: ${dur(holds.reduce((s, h) => s + h, 0) / (holds.length || 1))}`);
  console.log(`intraday (<24h): ${closedTrips.length ? pct(intraday / closedTrips.length) : 'n/a'} of round-trips  ${medHold < DAY ? '✅ INTRADAY profile' : '❌ multi-day holds'}`);

  // --- Consistency / cadence ---
  const days = new Set(fills.map((f) => Math.floor(f.time / DAY)));
  const spanDays = Math.max(1, Math.round(span / DAY));
  console.log('\n── CONSISTENCY / CADENCE ──');
  console.log(`active window: ${new Date(firstT).toISOString().slice(0, 10)} → ${new Date(lastT).toISOString().slice(0, 10)} (${spanDays}d span)`);
  console.log(`active days: ${days.size}/${spanDays} (${pct(days.size / spanDays)})  |  round-trips/active-day: ${(closedTrips.length / days.size).toFixed(1)}`);

  // --- Concentration ---
  const tripsByCoin = new Map<string, { n: number; pnl: number }>();
  for (const t of closedTrips) {
    const e = tripsByCoin.get(t.coin) ?? { n: 0, pnl: 0 };
    e.n += 1;
    e.pnl += t.pnl;
    tripsByCoin.set(t.coin, e);
  }
  const coinsRanked = [...tripsByCoin.entries()].sort((a, b) => b[1].n - a[1].n);
  const top3Share = coinsRanked.slice(0, 3).reduce((s, [, e]) => s + e.n, 0) / (closedTrips.length || 1);
  console.log('\n── CONCENTRATION ──');
  console.log(`distinct coins traded: ${tripsByCoin.size}  |  top-3 coins = ${pct(top3Share)} of round-trips  ${tripsByCoin.size <= 6 ? '✅ FEW positions' : '❌ spread across many'}`);
  console.log('top coins (round-trips, net pnl):');
  for (const [coin, e] of coinsRanked.slice(0, 8)) console.log(`   ${coin.padEnd(8)} ${String(e.n).padStart(4)} trips   ${usd(e.pnl)}`);

  // --- Risk posture ---
  // cumulative realized PnL drawdown
  const ordered = [...closedTrips].sort((a, b) => a.closeTime - b.closeTime);
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of ordered) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  const liqFills = fills.filter((f) => /liquidat/i.test(f.dir ?? ''));
  const analytics = buildCopyMonitorAnalytics(null, state, fills);
  console.log('\n── RISK POSTURE ──');
  console.log(`account value now: ${usd(state.accountValueUsd)}  |  open positions: ${state.positions.length}`);
  console.log(`max realized-PnL drawdown: ${usd(maxDd)} (${peak > 0 ? pct(maxDd / peak) : 'n/a'} of peak)`);
  console.log(`liquidation fills detected: ${liqFills.length}${liqFills.length ? ' ⚠️' : ''}`);
  console.log(`same-direction adds (martingale proxy): ${analytics.totalAdds}`);
  if (state.positions.length) {
    console.log('current open:');
    for (const p of state.positions) {
      console.log(
        `   ${p.side.toUpperCase().padEnd(5)} ${p.coin.padEnd(8)} ${p.leverage ? p.leverage + 'x' : '?x'}  notional ${usd(p.positionValue)}  uPnL ${usd(p.unrealizedPnl)}${p.unrealizedPnl < -state.accountValueUsd * 0.25 ? ' 🚨 deeply underwater' : ''}`,
      );
    }
  }
  console.log('\nalerts:');
  for (const a of analytics.alerts) console.log(`   [${a.severity}] ${a.title}`);
  console.log('');
}

main().catch((e) => {
  console.error('research failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
