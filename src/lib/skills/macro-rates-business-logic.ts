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
  // Direction only means something when the move is at least notable.
  const riskSignal: RatesRead['riskSignal'] =
    magnitude === 'quiet' ? 'neutral' : d1Bp + d5Bp / 2 > 0 ? 'risk-off-pressure' : 'easing-tailwind';
  return { latest, d1Bp, d5Bp, windowHighPct, windowLowPct, magnitude, riskSignal };
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
