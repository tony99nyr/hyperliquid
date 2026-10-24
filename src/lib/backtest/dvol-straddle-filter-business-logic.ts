/** Pure, preregistered DVOL versus realised-volatility straddle study. */
export interface StraddleLeg {
  eventId: string;
  coin: 'BTC' | 'ETH';
  printAtMs: number;
  /** Slip-aware outcome divided by the leg's planned risk. */
  netR: number;
  riskUsd: number;
}

export interface DailyClose { timestamp: number; close: number }
export interface DvolObservation { timestamp: number; value: number }
export interface VolatilityHistory { closes: DailyClose[]; dvol: DvolObservation[] }

export interface EligibleDvolPrint {
  eventId: string;
  coin: 'BTC' | 'ETH' | 'BTC+ETH';
  printAtMs: number;
  netR: number;
  realisedVol: number;
  dvol: number;
  ratio: number;
}

export interface DvolStudyResult {
  coverage: { inputLegs: number; prints: number; eligible: number; excluded: number };
  eligible: EligibleDvolPrint[];
  cheap: { n: number; meanNetR: number | null };
  rich: { n: number; meanNetR: number | null };
  differenceR: number | null;
  verdict: 'insufficient evidence' | 'survives' | 'kill';
}

const DAY_MS = 86_400_000;
const MAX_DVOL_AGE_MS = 3_600_000;

/** Sample standard deviation of 29 log returns from the last 30 complete UTC daily closes. */
export function realisedVolatility(closes: DailyClose[], printAtMs: number): number | null {
  const startOfPrintDay = Math.floor(printAtMs / DAY_MS) * DAY_MS;
  const daily = new Map<number, number>();
  for (const item of closes) {
    if (!Number.isFinite(item.timestamp) || !Number.isFinite(item.close) || item.close <= 0) continue;
    if (item.timestamp <= startOfPrintDay && item.timestamp % DAY_MS === 0) daily.set(item.timestamp, item.close);
  }
  const dates = [...daily.keys()].sort((a, b) => b - a).slice(0, 30).reverse();
  if (dates.length !== 30 || dates[29] !== startOfPrintDay ||
    dates.some((date, index) => index > 0 && date - dates[index - 1] !== DAY_MS)) return null;
  const returns = dates.slice(1).map((date, index) => Math.log((daily.get(date) ?? 0) / (daily.get(dates[index]) ?? 0)));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const vol = Math.sqrt(variance * 365) * 100;
  return Number.isFinite(vol) && vol > 0 ? vol : null;
}

function latestDvol(observations: DvolObservation[], printAtMs: number): number | null {
  let latest: DvolObservation | null = null;
  for (const observation of observations) {
    if (!Number.isFinite(observation.value) || observation.value <= 0 || !Number.isFinite(observation.timestamp)) continue;
    if (observation.timestamp > printAtMs || printAtMs - observation.timestamp > MAX_DVOL_AGE_MS) continue;
    if (!latest || observation.timestamp > latest.timestamp) latest = observation;
  }
  return latest?.value ?? null;
}

function meanNetR(rows: EligibleDvolPrint[]): number | null {
  return rows.length ? rows.reduce((sum, row) => sum + row.netR, 0) / rows.length : null;
}

export function evaluateDvolStraddles(
  legs: StraddleLeg[],
  history: Partial<Record<'BTC' | 'ETH', VolatilityHistory>>,
): DvolStudyResult {
  const groups = new Map<string, StraddleLeg[]>();
  for (const leg of legs) {
    const key = String(leg.printAtMs);
    groups.set(key, [...(groups.get(key) ?? []), leg]);
  }
  const eligible: EligibleDvolPrint[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first || !Number.isFinite(first.printAtMs) || !first.eventId ||
      group.some((leg) => !Number.isFinite(leg.netR) || !Number.isFinite(leg.riskUsd) || leg.riskUsd <= 0)) continue;
    const readings = group.map((leg) => {
      const coinHistory = history[leg.coin];
      if (!coinHistory) return null;
      const realisedVol = realisedVolatility(coinHistory.closes, leg.printAtMs);
      const dvol = latestDvol(coinHistory.dvol, leg.printAtMs);
      return realisedVol === null || dvol === null ? null : { leg, realisedVol, dvol };
    });
    if (readings.some((reading) => reading === null)) continue;
    const valid = readings.filter((reading): reading is NonNullable<typeof reading> => reading !== null);
    const risk = group.reduce((sum, leg) => sum + leg.riskUsd, 0);
    const coins = new Set(group.map((leg) => leg.coin));
    eligible.push({
      eventId: group.map((leg) => leg.eventId).sort()[0],
      coin: coins.size === 2 ? 'BTC+ETH' : first.coin, printAtMs: first.printAtMs,
      netR: group.reduce((sum, leg) => sum + leg.netR * leg.riskUsd, 0) / risk,
      realisedVol: valid.reduce((sum, row) => sum + row.realisedVol * row.leg.riskUsd, 0) / risk,
      dvol: valid.reduce((sum, row) => sum + row.dvol * row.leg.riskUsd, 0) / risk,
      ratio: valid.reduce((sum, row) => sum + (row.dvol / row.realisedVol) * row.leg.riskUsd, 0) / risk,
    });
  }
  eligible.sort((a, b) => a.ratio - b.ratio || a.printAtMs - b.printAtMs || a.eventId.localeCompare(b.eventId));
  const tercileSize = Math.floor(eligible.length / 3);
  const cheapRows = eligible.slice(0, tercileSize);
  const richRows = eligible.slice(eligible.length - tercileSize);
  const cheapMean = meanNetR(cheapRows);
  const richMean = meanNetR(richRows);
  const differenceR = cheapMean === null || richMean === null ? null : cheapMean - richMean;
  return {
    coverage: { inputLegs: legs.length, prints: groups.size, eligible: eligible.length, excluded: groups.size - eligible.length },
    eligible,
    cheap: { n: cheapRows.length, meanNetR: cheapMean },
    rich: { n: richRows.length, meanNetR: richMean },
    differenceR,
    verdict: tercileSize < 15 ? 'insufficient evidence' : (differenceR !== null && differenceR >= 0.3 ? 'survives' : 'kill'),
  };
}
