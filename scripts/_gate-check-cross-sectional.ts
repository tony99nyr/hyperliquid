/**
 * Lane C GATE-CHECK (one-off analysis, not a shipped lane). Per
 * docs/scout/SCOUT_ALPHA_ROADMAP.md, Lane C (cross-sectional) is built ONLY if a
 * realistic backtest on the TRADABLE HL-majors universe clears the bar. This runs
 * a daily cross-sectional momentum long-short (long the strongest trailing-return
 * coin, short the weakest — market-neutral) over ETH/BTC/SOL/HYPE, net of taker +
 * slippage on rebalances. Pre-registered verdict below. Run:
 *   pnpm tsx --tsconfig tsconfig.scripts.json scripts/_gate-check-cross-sectional.ts
 */

import { fetchCandles } from '@/lib/hyperliquid/candle-service';

// Universe overridable via argv to probe single-name fragility (e.g. drop HYPE).
const UNIVERSE = process.argv.slice(2).filter((a) => !a.startsWith('-')).map((s) => s.toUpperCase());
if (UNIVERSE.length < 2) UNIVERSE.push('ETH', 'BTC', 'SOL', 'HYPE');
const LOOKBACKS = [7, 14, 30]; // trailing-return windows to rank by (robustness, not cherry-pick)
const ROUNDTRIP_BPS = 19; // ~9.5bps taker+slippage × 2 (close old + open new) per changed leg
// PRE-REGISTERED BAR (decided before results): clears only if, robustly across the
// lookbacks, net-of-cost annualized return > 0 AND annualized Sharpe > 0.5.
const BAR = { minAnnReturn: 0, minSharpe: 0.5 };

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1));
};

async function main() {
  const start = Date.now() - 730 * 86_400_000;
  console.log('Lane C gate-check — cross-sectional momentum on', UNIVERSE.join('/'), '(daily, ~2y or coin lifetime)\n');

  // Fetch daily closes, index by day.
  const closesByCoin: Record<string, Map<number, number>> = {};
  for (const coin of UNIVERSE) {
    const res = await fetchCandles(coin, '1d', start).catch(() => null);
    const m = new Map<number, number>();
    for (const c of res?.candles ?? []) m.set(Math.floor(c.timestamp / 86_400_000), c.close);
    closesByCoin[coin] = m;
    console.log(`  ${coin}: ${m.size} daily candles`);
  }
  // Common day axis (intersection — bounded by the youngest coin, e.g. HYPE).
  const days = [...closesByCoin[UNIVERSE[0]].keys()]
    .filter((d) => UNIVERSE.every((c) => closesByCoin[c].has(d)))
    .sort((a, b) => a - b);
  console.log(`  common days: ${days.length} (${new Date(days[0] * 86_400_000).toISOString().slice(0, 10)} → ${new Date(days[days.length - 1] * 86_400_000).toISOString().slice(0, 10)})\n`);
  const ret = (coin: string, d0: number, d1: number) => closesByCoin[coin].get(d1)! / closesByCoin[coin].get(d0)! - 1;

  let clearedAll = true;
  for (const L of LOOKBACKS) {
    const daily: number[] = [];
    let prevLong: string | null = null;
    let prevShort: string | null = null;
    for (let i = L; i + 1 < days.length; i++) {
      const d = days[i];
      const dPrev = days[i - L];
      const dNext = days[i + 1];
      // rank by trailing-L return; long the best, short the worst.
      const ranked = [...UNIVERSE].sort((a, b) => ret(b, dPrev, d) - ret(a, dPrev, d));
      const long = ranked[0];
      const short = ranked[ranked.length - 1];
      const gross = ret(long, d, dNext) - ret(short, d, dNext); // equal-notional long-short
      const cost = (((prevLong !== long ? 1 : 0) + (prevShort !== short ? 1 : 0)) * ROUNDTRIP_BPS) / 10_000;
      daily.push(gross - cost);
      prevLong = long;
      prevShort = short;
    }
    const total = daily.reduce((a, b) => a + b, 0);
    const annReturn = mean(daily) * 365;
    const sharpe = std(daily) > 0 ? (mean(daily) / std(daily)) * Math.sqrt(365) : 0;
    const cleared = annReturn > BAR.minAnnReturn && sharpe > BAR.minSharpe;
    clearedAll = clearedAll && cleared;
    console.log(
      `L=${L}d:  ${daily.length} reb  total ${(total * 100).toFixed(1)}%  annRet ${(annReturn * 100).toFixed(1)}%  Sharpe ${sharpe.toFixed(2)}  → ${cleared ? 'CLEARS' : 'fails'}`,
    );
  }

  console.log(`\nPRE-REGISTERED BAR: annRet > ${BAR.minAnnReturn}%, Sharpe > ${BAR.minSharpe}, robust across lookbacks.`);
  console.log(`VERDICT: Lane C ${clearedAll ? 'CLEARS → build it' : 'REJECTED at the gate → do NOT build (consistent with the research: cross-sectional edge lives in micro-caps, not 4 correlated majors)'}`);
}

main().catch((e) => { console.error('gate-check failed:', e instanceof Error ? e.message : e); process.exit(1); });
