/**
 * Macro rates read — PURE. The 30Y Treasury yield is the desk's fiscal/liquidity
 * barometer (operator doctrine, 08-20): the Aug-2026 sequence — 30Y spiking to a
 * 19-year high (5.34%) on fiscal fears → crypto chop/dump, then the Treasury doubling
 * buybacks → yields plunging → the risk-on crypto rally — is the linkage this watches.
 * Yields RISING hard = fiscal stress / risk-off pressure on crypto; yields FALLING
 * hard = policy easing / risk-on tailwind. It is CONTEXT and a thesis TRIPWIRE (a
 * re-spike kills the "policy-response risk-on" macro-continuation thesis), never a
 * trade signal on its own.
 *
 * Input: FRED DGS30 CSV (daily EOD, ~1 business day lag — say so, never imply intraday).
 */

export interface RatesPoint {
  date: string; // YYYY-MM-DD
  yieldPct: number; // e.g. 5.28
}

export interface RatesRead {
  latest: RatesPoint;
  /** 1-day change in BASIS POINTS (latest vs prior print). */
  d1Bp: number;
  /** 5-print change in basis points (≈ one trading week). */
  d5Bp: number;
  /** Highest yield in the window (the stress reference, e.g. the 5.34 spike zone). */
  windowHighPct: number;
  windowLowPct: number;
  /** 'macro-move' ≥15bp 1d · 'notable' ≥8bp · 'quiet' below. */
  magnitude: 'macro-move' | 'notable' | 'quiet';
  /** The crypto-desk translation of the DIRECTION of the latest move. */
  riskSignal: 'risk-off-pressure' | 'easing-tailwind' | 'neutral';
}

/** Parse the FRED fredgraph CSV ("DATE,DGS30"; '.' = market holiday) into points. PURE. */
export function parseFredCsv(csv: string): RatesPoint[] {
  const out: RatesPoint[] = [];
  for (const line of csv.split('\n').slice(1)) {
    const [date, v] = line.trim().split(',');
    const y = Number(v);
    if (date && Number.isFinite(y) && y > 0) out.push({ date, yieldPct: y });
  }
  return out;
}

const MACRO_MOVE_BP = 15;
const NOTABLE_BP = 8;

/** Fold the series into the desk read. Null when too thin (<6 prints). PURE. */
export function ratesRead(points: RatesPoint[]): RatesRead | null {
  if (points.length < 6) return null;
  const latest = points[points.length - 1];
  const prev = points[points.length - 2];
  const wk = points[points.length - 6];
  const d1Bp = Math.round((latest.yieldPct - prev.yieldPct) * 100);
  const d5Bp = Math.round((latest.yieldPct - wk.yieldPct) * 100);
  const windowHighPct = Math.max(...points.map((p) => p.yieldPct));
  const windowLowPct = Math.min(...points.map((p) => p.yieldPct));
  const mag = Math.max(Math.abs(d1Bp), Math.abs(d5Bp) / 2);
  const magnitude: RatesRead['magnitude'] = mag >= MACRO_MOVE_BP ? 'macro-move' : mag >= NOTABLE_BP ? 'notable' : 'quiet';
  // Direction follows WHICHEVER horizon made the move notable — the 1d print when it is
  // itself notable, else the 5d grind. (The old d1+d5/2 blend could label a −9bp DOWN
  // day 'risk-off' because last week ground up — a ±1bp blend deciding the flag was
  // noise; review 08-20 M3.) Exactly-zero direction stays neutral.
  const dirBp = Math.abs(d1Bp) >= NOTABLE_BP ? d1Bp : d5Bp;
  const riskSignal: RatesRead['riskSignal'] =
    magnitude === 'quiet' || dirBp === 0 ? 'neutral' : dirBp > 0 ? 'risk-off-pressure' : 'easing-tailwind';
  return { latest, d1Bp, d5Bp, windowHighPct, windowLowPct, magnitude, riskSignal };
}

// ---------- The liquidity dashboard (08-21): 10Y + dollar + breakevens ----------
// Added after the Treasury-buyback rally: the 30Y alone caught the impulse, but the
// LIQUIDITY picture that drives crypto is yields × the dollar × real rates. All FRED,
// keyless, EOD (~1-3 day lag on DTWEXBGS) — CONTEXT ONLY, never a signal.

/** Generic last/Δ1/Δ5 fold in the series' NATIVE units (%, index points). PURE. */
export function seriesDelta(points: RatesPoint[]): { latest: RatesPoint; d1: number; d5: number } | null {
  if (points.length < 6) return null;
  const latest = points[points.length - 1];
  return {
    latest,
    d1: latest.yieldPct - points[points.length - 2].yieldPct,
    d5: latest.yieldPct - points[points.length - 6].yieldPct,
  };
}

export interface LiquidityDashboard {
  y10: ReturnType<typeof seriesDelta>; // % (yield)
  dxy: ReturnType<typeof seriesDelta>; // index points
  breakeven: ReturnType<typeof seriesDelta>; // % (10Y inflation breakeven)
  /** 10Y − breakeven when both present — the real-rate proxy (the purest liquidity read). */
  realYieldPct: number | null;
  /** Crypto-desk lean from the 5d directions: yields↓ + dollar↓ + real↓ = risk-on.
   *  A full risk-on/off label requires ≥2 agreeing votes; fewer = mixed/neutral. */
  lean: 'risk-on' | 'risk-off' | 'mixed' | 'neutral';
  /** Signed vote sum (+ = easing) and how many components could vote — printed so a
   *  partial read never masquerades as a full-dashboard call. */
  votesFor: number;
  votesCast: number;
}

export function liquidityDashboard(
  y10Pts: RatesPoint[],
  dxyPts: RatesPoint[],
  bePts: RatesPoint[],
): LiquidityDashboard {
  const y10 = seriesDelta(y10Pts);
  const dxy = seriesDelta(dxyPts);
  const breakeven = seriesDelta(bePts);
  const realYieldPct = y10 && breakeven ? Number((y10.latest.yieldPct - breakeven.latest.yieldPct).toFixed(2)) : null;
  // Vote per component on its 5d direction past a noise floor (yields/real 5bp, DXY 0.5%).
  let vote = 0;
  let voted = 0;
  if (y10 && Math.abs(y10.d5) >= 0.05) { vote += y10.d5 < 0 ? 1 : -1; voted++; }
  if (dxy && dxy.latest.yieldPct > 0 && Math.abs(dxy.d5 / dxy.latest.yieldPct) >= 0.005) { vote += dxy.d5 < 0 ? 1 : -1; voted++; }
  if (y10 && breakeven) {
    const realD5 = y10.d5 - breakeven.d5;
    if (Math.abs(realD5) >= 0.05) { vote += realD5 < 0 ? 1 : -1; voted++; }
  }
  // A full risk-on/off label needs ≥2 agreeing components — one voter alone is a
  // 'mixed' read, not a regime call (review 08-21: a single-series partial read was
  // printing "RISK-ON (yields/dollar/real easing)" while two of the three were unread).
  const lean: LiquidityDashboard['lean'] =
    voted === 0 ? 'neutral' : voted >= 2 && vote === voted ? 'risk-on' : voted >= 2 && vote === -voted ? 'risk-off' : 'mixed';
  return { y10, dxy, breakeven, realYieldPct, lean, votesFor: vote, votesCast: voted };
}

/** One desk-review line for the dashboard. PURE. Per-series as-of dates are shown —
 *  FRED publication lags DIFFER (DTWEXBGS is weekly-published and can trail DGS10 by
 *  ~a week), so the 5d windows may end on different days; undated they'd mislead. */
export function liquidityLine(d: LiquidityDashboard): string {
  const bp = (x: number) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}bp`;
  const asOf = (date: string) => date.slice(5); // MM-DD
  const parts: string[] = [];
  if (d.y10) parts.push(`10Y ${d.y10.latest.yieldPct.toFixed(2)}% (${bp(d.y10.d5)} 5d, ${asOf(d.y10.latest.date)})`);
  if (d.dxy) parts.push(`DXY ${d.dxy.latest.yieldPct.toFixed(1)} (${d.dxy.d5 >= 0 ? '+' : ''}${d.dxy.d5.toFixed(1)} 5d, ${asOf(d.dxy.latest.date)})`);
  if (d.breakeven && d.realYieldPct != null) parts.push(`real 10Y ≈ ${d.realYieldPct.toFixed(2)}%`);
  if (parts.length === 0) return '(liquidity dashboard unavailable)';
  const tally = ` [${d.votesFor >= 0 ? '+' : ''}${d.votesFor}/${d.votesCast} components]`;
  const leanTxt =
    d.lean === 'risk-on' ? ` → liquidity lean: RISK-ON${tally}` :
    d.lean === 'risk-off' ? ` → liquidity lean: RISK-OFF${tally}` :
    d.lean === 'mixed' ? ` → liquidity lean: mixed${tally}` : '';
  return `${parts.join(' · ')}${leanTxt}`;
}

/** One desk-review line. PURE. */
export function ratesLine(r: RatesRead): string {
  const arrow = r.d1Bp > 0 ? '↑' : r.d1Bp < 0 ? '↓' : '→';
  const flag =
    r.magnitude === 'macro-move'
      ? r.riskSignal === 'risk-off-pressure'
        ? ' ⚠ MACRO MOVE — yields spiking: fiscal-stress / risk-OFF pressure on crypto (check the macro-continuation thesis tripwire)'
        : ' 🟢 MACRO MOVE — yields plunging: easing / risk-ON tailwind'
      : r.magnitude === 'notable'
        ? r.riskSignal === 'risk-off-pressure'
          ? ' (notable — leaning risk-off)'
          : ' (notable — leaning risk-on)'
        : '';
  return (
    `30Y ${r.latest.yieldPct.toFixed(2)}% ${arrow} (${r.d1Bp >= 0 ? '+' : ''}${r.d1Bp}bp 1d, ` +
    `${r.d5Bp >= 0 ? '+' : ''}${r.d5Bp}bp 5d; window ${r.windowLowPct.toFixed(2)}-${r.windowHighPct.toFixed(2)}%) ` +
    `as of ${r.latest.date} EOD (FRED, ~1-day lag)${flag}`
  );
}
