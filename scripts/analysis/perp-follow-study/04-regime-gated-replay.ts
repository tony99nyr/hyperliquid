/**
 * Part B: regime-gated following replay, 4 arms, out-of-sample.
 *
 * Selection at window N (on data <= end of N) by two methods (winRate, consistency).
 * Judge on window N+1 leader ETH/BTC entry fills. Four arms:
 *   (i)  UNCONDITIONAL  — mirror every selected-leader ETH/BTC entry; exit on leader close
 *   (ii) REGIME-GATED   — mirror only when OUR regime agrees at gate confidence; exit at
 *                         min(leader_close, our regime flip/decay)
 *   (iii)REGIME-ALONE   — our detector trades direction; no leader
 *   (iv) HOLD           — buy & hold over the judged span
 *
 * Costs: taker fee + slippage per side, realized hourly funding (sign-correct).
 * Latency: realistic = next-8h-boundary + uniform relayer delay in [0,6.5h];
 *          sensitivity arms at instant and +1h.
 *
 * Price for entries/exits/our-arm = OUR HL daily close at the (latency-adjusted) ts.
 *
 * Output: data/backups/perp-follow-study/partB-results.json
 */
import * as fs from 'fs';
import { PATHS, PARTB, RNG_SEED_PARTB } from './study-config';
import { loadCachedFills, buildAllRoundTrips, type RoundTrip, type Fill } from './lib-fills';
import { regimeAt, fundingFractionLong, priceAt1h } from './lib-regime-funding';
import { windowBounds, mulberry32, mean, std, median } from '../hyperliquid-persistence/lib';

const OUT = `${PATHS.OUT_DIR}/partB-results.json`;
const HOUR = 3_600_000;

interface Profile {
  address: string; active: boolean; ethBtcEntryFills: number;
  perWindow: Array<{ nTrips: number; winRate: number; pnl: number; pnlRet: number } | null>;
  trailing60: { perTradeSharpe: number; winRate: number; maxDrawdownFrac: number };
}

function loadProfiles(): Profile[] {
  const f = `${PATHS.OUT_DIR}/profiles.jsonl`;
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Profile);
}

// ---- latency model ----
function applyLatency(ts: number, mode: 'instant' | 'plus1h' | 'realistic', rng: () => number): number {
  if (mode === 'instant') return ts;
  if (mode === 'plus1h') return ts + HOUR;
  // realistic: snap UP to next 8h boundary, then add uniform relayer delay [0,6.5h]
  const boundary = Math.ceil(ts / (PARTB.SIGNAL_CADENCE_HOURS * HOUR)) * (PARTB.SIGNAL_CADENCE_HOURS * HOUR);
  return boundary + rng() * PARTB.RELAYER_MAX_HOURS * HOUR;
}

// One mirrored trade's net return (fraction of notional), costed. Prices use OUR
// 1h candles (finer than daily; falls back to daily before 1h coverage).
function tradeNetReturn(
  coin: 'ETH' | 'BTC', side: 'long' | 'short', entryTs: number, exitTs: number,
): number | null {
  const pEntry = priceAt1h(coin, entryTs);
  const pExit = priceAt1h(coin, exitTs);
  if (pEntry == null || pExit == null || pEntry <= 0) return null;
  const gross = side === 'long' ? (pExit - pEntry) / pEntry : (pEntry - pExit) / pEntry;
  const fees = 2 * PARTB.TAKER_FEE_PER_SIDE + 2 * PARTB.SLIPPAGE_PER_SIDE;
  const fundLong = fundingFractionLong(coin, entryTs, exitTs); // long pays this
  const funding = side === 'long' ? -fundLong : fundLong;
  return gross - fees + funding;
}

// Our-regime exit: earliest ts after entry where regime leaves the trade direction or decays below gate.
function regimeExitTs(coin: 'ETH' | 'BTC', side: 'long' | 'short', entryTs: number, hardExitTs: number, confBar: number): number {
  const want: 'bullish' | 'bearish' = side === 'long' ? 'bullish' : 'bearish';
  // step daily
  const DAY = 86_400_000;
  for (let t = entryTs + DAY; t < hardExitTs; t += DAY) {
    const r = regimeAt(coin, t);
    if (!r || r.regime !== want || r.confidence < confBar) return t;
  }
  return hardExitTs;
}

interface ArmAcc { rets: number[] }
function newArm(): ArmAcc { return { rets: [] }; }
function summarize(a: ArmAcc) {
  const m = mean(a.rets);
  const sd = std(a.rets);
  return {
    nTrades: a.rets.length,
    meanRet: m,
    medianRet: median(a.rets),
    totalRet: a.rets.reduce((x, y) => x + y, 0),
    sharpe: sd > 0 ? m / sd : 0, // per-trade
    winRate: a.rets.filter((r) => r > 0).length / (a.rets.length || 1),
    worst: a.rets.length ? Math.min(...a.rets) : 0,
  };
}

function main() {
  const rng = mulberry32(RNG_SEED_PARTB);
  const profiles = loadProfiles();

  // Candidate leader pool for Part B = anyone with ETH/BTC round-trips we can replay.
  // Combine off-leaderboard discovered (profiles) + cached Gate-1 cohort fills.
  const gate1Cohort = fs.existsSync(`${PATHS.HL_DIR}/fills`)
    ? fs.readdirSync(`${PATHS.HL_DIR}/fills`).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''))
    : [];

  // Build per-address ETH/BTC round-trips (entry fills) from whatever fills we have.
  interface Lead { address: string; trips: RoundTrip[]; source: 'offlb' | 'gate1' }
  const leaders: Lead[] = [];
  const addrSet = new Set<string>();
  for (const p of profiles) {
    if (p.ethBtcEntryFills <= 0) continue;
    const fills = loadCachedFills(p.address);
    if (!fills) continue;
    const trips = buildAllRoundTrips(fills).filter((t) => t.coin === 'ETH' || t.coin === 'BTC');
    if (trips.length) { leaders.push({ address: p.address, trips, source: 'offlb' }); addrSet.add(p.address); }
  }
  for (const addr of gate1Cohort) {
    if (addrSet.has(addr)) continue;
    const fills = loadCachedFills(addr);
    if (!fills) continue;
    const trips = buildAllRoundTrips(fills).filter((t) => t.coin === 'ETH' || t.coin === 'BTC');
    if (trips.length) { leaders.push({ address: addr, trips, source: 'gate1' }); addrSet.add(addr); }
  }

  // selection metric per leader up to end of window N
  function selectionScore(lead: Lead, windowEnd: number, method: 'winRate' | 'consistency'): number | null {
    const past = lead.trips.filter((t) => t.closeTime <= windowEnd);
    if (past.length < 10) return null;
    if (method === 'winRate') return past.filter((t) => t.win).length / past.length;
    // consistency = mean per-trade return / std (risk-adjusted)
    const rets = past.map((t) => (t.entryNotional > 0 ? t.realizedPnl / t.entryNotional : 0));
    const m = mean(rets), sd = std(rets);
    return sd > 0 ? m / sd : 0;
  }

  const latencyModes = ['realistic', 'instant', 'plus1h'] as const;
  const selMethods = ['winRate', 'consistency'] as const;
  const out: Record<string, unknown> = {
    meta: {
      nLeadersWithEthBtc: leaders.length,
      offlb: leaders.filter((l) => l.source === 'offlb').length,
      gate1: leaders.filter((l) => l.source === 'gate1').length,
      gateConfPrimary: PARTB.REGIME_CONFIDENCE_PRIMARY,
      gateConfStrict: PARTB.REGIME_CONFIDENCE_STRICT,
      note: 'Replay over ETH/BTC round-trip entries; OOS select on window N, judge entries in N+1.',
    },
  };

  for (const method of selMethods) {
    for (const latency of latencyModes) {
      for (const confBar of [PARTB.REGIME_CONFIDENCE_PRIMARY, PARTB.REGIME_CONFIDENCE_STRICT]) {
        const armI = newArm(), armII = newArm(), armIII = newArm(), armIV = newArm();
        let nSelWindows = 0;
        const selectedSharpeSamples: number[] = [];

        for (let N = 0; N < 5; N++) {
          const wN = windowBounds(N);
          const wNext = windowBounds(N + 1);
          // rank leaders on data up to end of N
          const scored = leaders
            .map((l) => ({ l, s: selectionScore(l, wN.end, method) }))
            .filter((x) => x.s != null) as Array<{ l: Lead; s: number }>;
          if (scored.length < 3) continue;
          scored.sort((a, b) => b.s - a.s);
          const chosen = scored.slice(0, PARTB.N_LEADERS);
          nSelWindows++;
          for (const c of chosen) selectedSharpeSamples.push(c.s);

          for (const { l } of chosen) {
            // entries opened during window N+1
            const entries = l.trips.filter((t) => t.openTime >= wNext.start && t.openTime < wNext.end);
            for (const e of entries) {
              const coin = e.coin as 'ETH' | 'BTC';
              const lev = applyLatency(e.openTime, latency, rng);
              const leaderClose = e.closeTime;

              // ARM i: unconditional
              const ri = tradeNetReturn(coin, e.side, lev, applyLatency(leaderClose, latency, rng));
              if (ri != null) armI.rets.push(ri);

              // ARM ii: regime-gated
              const r = regimeAt(coin, lev);
              const want = e.side === 'long' ? 'bullish' : 'bearish';
              if (r && r.regime === want && r.confidence >= confBar) {
                const hardExit = applyLatency(leaderClose, latency, rng);
                const ourExit = regimeExitTs(coin, e.side, lev, hardExit, confBar);
                const rii = tradeNetReturn(coin, e.side, lev, ourExit);
                if (rii != null) armII.rets.push(rii);
              }
            }
          }
          // ARM iii: regime-alone (independent of leaders) — one position per coin per daily
          // regime state change in window N+1. Direction from our detector; entry/exit at flips.
          for (const coin of ['ETH', 'BTC'] as const) {
            const DAY = 86_400_000;
            let curSide: 'long' | 'short' | null = null;
            let entryTs = 0;
            for (let t = wNext.start; t < wNext.end; t += DAY) {
              const rr = regimeAt(coin, t);
              const dir: 'long' | 'short' | null = rr && rr.confidence >= confBar
                ? (rr.regime === 'bullish' ? 'long' : rr.regime === 'bearish' ? 'short' : null) : null;
              if (dir !== curSide) {
                if (curSide) { const rr3 = tradeNetReturn(coin, curSide, entryTs, t); if (rr3 != null) armIII.rets.push(rr3); }
                curSide = dir; entryTs = t;
              }
            }
            if (curSide) { const rr3 = tradeNetReturn(coin, curSide, entryTs, wNext.end); if (rr3 != null) armIII.rets.push(rr3); }
          }
          // ARM iv: hold each coin across window N+1
          for (const coin of ['ETH', 'BTC'] as const) {
            const rr4 = tradeNetReturn(coin, 'long', wNext.start, wNext.end);
            if (rr4 != null) armIV.rets.push(rr4);
          }
        }

        // deflated-Sharpe-ish: expected max selection score under shuffle not needed here;
        // record the spread of selected scores for the verdict layer.
        const key = `${method}|lat=${latency}|conf=${confBar}`;
        out[key] = {
          nSelWindows,
          armI_unconditional: summarize(armI),
          armII_regimeGated: summarize(armII),
          armIII_regimeAlone: summarize(armIII),
          armIV_hold: summarize(armIV),
          selectedScore: { mean: mean(selectedSharpeSamples), median: median(selectedSharpeSamples) },
        };
      }
    }
  }

  // =========================================================================
  // POOLED forward-entry replay (the COMPUTABLE Part B).
  // The strict select-on-N / judge-on-N+1 design above is near-empty because the
  // public fill endpoint retains only ~12k most-recent fills, so a wallet's ETH/BTC
  // history almost never spans both a selection window AND the next judgment window.
  // The pooled variant preserves OOS discipline differently: for EVERY ETH/BTC entry
  // by a leader, we score that leader using ONLY their round-trips that CLOSED BEFORE
  // the entry (strictly causal), require the leader to clear a quality bar at that
  // moment, then replay the entry under the 4 arms. No window-pair overlap needed.
  // =========================================================================
  function leaderScoreBefore(lead: Lead, ts: number, method: 'winRate' | 'consistency'): { score: number; n: number } | null {
    const past = lead.trips.filter((t) => t.closeTime < ts);
    if (past.length < 10) return null;
    if (method === 'winRate') return { score: past.filter((t) => t.win).length / past.length, n: past.length };
    const rets = past.map((t) => (t.entryNotional > 0 ? t.realizedPnl / t.entryNotional : 0));
    const m = mean(rets), sd = std(rets);
    return { score: sd > 0 ? m / sd : 0, n: past.length };
  }

  // Collect every ETH/BTC entry with its leader's causal score; keep top-quality leaders
  // (per-method top tercile of scores observed) — a fixed, declared selection bar.
  const pooled: Record<string, unknown> = {};
  for (const method of selMethods) {
    // first pass: gather all (entry, score)
    const events: Array<{ coin: 'ETH' | 'BTC'; side: 'long' | 'short'; openTime: number; closeTime: number; score: number }> = [];
    for (const l of leaders) {
      for (const t of l.trips) {
        if (t.openTime < windowBounds(1).start) continue; // only judge entries within 1h-candle coverage era-ish
        const s = leaderScoreBefore(l, t.openTime, method);
        if (!s) continue;
        events.push({ coin: t.coin as 'ETH' | 'BTC', side: t.side, openTime: t.openTime, closeTime: t.closeTime, score: s.score });
      }
    }
    if (!events.length) { pooled[method] = { note: 'no scorable entries' }; continue; }
    const scoreCut = (() => { const s = events.map((e) => e.score).sort((a, b) => a - b); return s[Math.floor(s.length * (2 / 3))]; })();
    const selected = events.filter((e) => e.score >= scoreCut);

    for (const latency of latencyModes) {
      for (const confBar of [PARTB.REGIME_CONFIDENCE_PRIMARY, PARTB.REGIME_CONFIDENCE_STRICT]) {
        const aI = newArm(), aII = newArm(), aIII = newArm(), aIV = newArm();
        // matched per-entry regime-alone: detector's own directional call over the
        // SAME hold window as each leader entry (true paired comparison vs arm ii).
        const aIIIm = newArm();
        for (const e of selected) {
          const lev = applyLatency(e.openTime, latency, rng);
          const exit = applyLatency(e.closeTime, latency, rng);
          const ri = tradeNetReturn(e.coin, e.side, lev, exit);
          if (ri != null) aI.rets.push(ri);
          const r = regimeAt(e.coin, lev);
          const want = e.side === 'long' ? 'bullish' : 'bearish';
          if (r && r.regime === want && r.confidence >= confBar) {
            const ourExit = regimeExitTs(e.coin, e.side, lev, exit, confBar);
            const rii = tradeNetReturn(e.coin, e.side, lev, ourExit);
            if (rii != null) aII.rets.push(rii);
          }
          // matched regime-alone: take OUR direction (ignore leader) over same span
          if (r && r.confidence >= confBar && r.regime !== 'neutral') {
            const ourSide = r.regime === 'bullish' ? 'long' : 'short';
            const rm = tradeNetReturn(e.coin, ourSide, lev, exit);
            if (rm != null) aIIIm.rets.push(rm);
          }
          // arm iv: hold same coin over same span (the leader's hold window)
          const riv = tradeNetReturn(e.coin, 'long', lev, exit);
          if (riv != null) aIV.rets.push(riv);
        }
        // arm iii (regime-alone) over the union span of all selected entries, per coin
        for (const coin of ['ETH', 'BTC'] as const) {
          const spanStart = Math.min(...selected.map((e) => e.openTime));
          const spanEnd = Math.max(...selected.map((e) => e.closeTime));
          const DAY = 86_400_000;
          let curSide: 'long' | 'short' | null = null, entryTs = 0;
          for (let t = spanStart; t < spanEnd; t += DAY) {
            const rr = regimeAt(coin, t);
            const dir = rr && rr.confidence >= confBar ? (rr.regime === 'bullish' ? 'long' : rr.regime === 'bearish' ? 'short' : null) : null;
            if (dir !== curSide) {
              if (curSide) { const r3 = tradeNetReturn(coin, curSide, entryTs, t); if (r3 != null) aIII.rets.push(r3); }
              curSide = dir as 'long' | 'short' | null; entryTs = t;
            }
          }
          if (curSide) { const r3 = tradeNetReturn(coin, curSide, entryTs, spanEnd); if (r3 != null) aIII.rets.push(r3); }
        }
        pooled[`${method}|lat=${latency}|conf=${confBar}`] = {
          nSelectedEntries: selected.length, scoreCut,
          armI_unconditional: summarize(aI), armII_regimeGated: summarize(aII),
          armIII_regimeAlone: summarize(aIII),
          armIIIm_regimeAloneMatched: summarize(aIIIm),
          armIV_hold: summarize(aIV),
        };
      }
    }
  }
  out.pooledForwardEntry = pooled;

  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log('[partB] written', OUT, '| leaders w/ ETH-BTC:', leaders.length);
}

main();
