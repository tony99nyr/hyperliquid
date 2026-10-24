/** Reconstruct scout exposure and estimate funding from historical hourly rates. Pure. */
import type { FundingPoint } from '@/lib/hyperliquid/candle-service';

export interface ScoutFill {
  session_id: string;
  coin: string;
  side: string;
  sz: number;
  px: number;
  filled_at: string;
}

export interface FundingEstimate {
  byLane: Record<string, number>;
  totalUsd: number;
  missingHoursByLane: Record<string, number>;
  earliestMs: number;
}

const HOUR = 3_600_000;

/** An hourly observation charges the quantity held at that hour, at the last fill price. */
export function estimateScoutFunding(
  fills: ReadonlyArray<ScoutFill>,
  laneBySessionCoin: Readonly<Record<string, string>>,
  fundingByCoin: Readonly<Record<string, ReadonlyArray<FundingPoint>>>,
  now: number,
): FundingEstimate {
  const byLane: Record<string, number> = {};
  const missingHoursByLane: Record<string, number> = {};
  const groups = new Map<string, ScoutFill[]>();
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const fill of fills) {
    const time = Date.parse(fill.filled_at);
    if (!Number.isFinite(time) || !Number.isFinite(fill.sz) || fill.sz <= 0 || !Number.isFinite(fill.px)) continue;
    earliestMs = Math.min(earliestMs, time);
    const key = `${fill.session_id}\u0000${fill.coin.toUpperCase()}`;
    const group = groups.get(key) ?? [];
    group.push(fill);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const coin = key.split('\u0000')[1];
    const lane = laneBySessionCoin[key] ?? 'directional';
    const rows = [...group].sort((a, b) => Date.parse(a.filled_at) - Date.parse(b.filled_at));
    // HL funding timestamps land a few ms after the hour, so key each rate by its hour bucket.
    const rates = new Map((fundingByCoin[coin] ?? []).map((point) => [Math.floor(point.time / HOUR) * HOUR, point.fundingHourly]));
    let signedSize = 0;
    let price = 0;
    let cursor = Date.parse(rows[0].filled_at);
    const accrue = (end: number) => {
      if (Math.abs(signedSize) < 1e-9) { cursor = end; return; }
      for (let hour = (Math.floor(cursor / HOUR) + 1) * HOUR; hour < end; hour += HOUR) {
        const rate = rates.get(hour);
        if (rate === undefined || !Number.isFinite(rate)) {
          missingHoursByLane[lane] = (missingHoursByLane[lane] ?? 0) + 1;
        } else {
          byLane[lane] = (byLane[lane] ?? 0) + signedSize * price * rate;
        }
      }
      cursor = end;
    };
    for (const row of rows) {
      const time = Date.parse(row.filled_at);
      accrue(time);
      const change = row.side === 'buy' ? row.sz : -row.sz;
      signedSize += change;
      if (Math.abs(signedSize) < 1e-9) signedSize = 0;
      price = row.px;
    }
    if (now > cursor) accrue(now);
  }
  return { byLane, missingHoursByLane, earliestMs, totalUsd: Object.values(byLane).reduce((sum, amount) => sum + amount, 0) };
}
