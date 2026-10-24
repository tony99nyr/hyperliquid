/** Pure, read-only counterfactual on completed htf replay trades. */
const HOUR = 3_600_000;
const EPISODE = 5 * 86_400_000;
const PREMIUM_BAR = 0.0001;

export interface FundingStudyTrade {
  coin: string;
  side: 'long' | 'short';
  entryTime: number;
  netR: number;
}

/** Both rates are fractions. HL is hourly; Binance is per eight hours. */
export interface FundingQuote {
  coin: string;
  time: number;
  hlHourly: number;
  binanceTime: number;
  binanceEightHour: number;
}

interface Group { n: number; episodes: number; meanR: number | null }
export interface FundingVetoResult {
  total: number;
  unclassified: number;
  vetoed: Group;
  kept: Group;
  keptMinusVetoedR: number | null;
  verdict: 'insufficient-evidence' | 'keep-for-forward-study' | 'kill';
}

function group(rows: FundingStudyTrade[]): Group {
  return {
    n: rows.length,
    episodes: new Set(rows.map((row) => Math.floor(row.entryTime / EPISODE))).size,
    meanR: rows.length ? rows.reduce((sum, row) => sum + row.netR, 0) / rows.length : null,
  };
}

export function assessFundingVeto(trades: FundingStudyTrade[], quotes: FundingQuote[]): FundingVetoResult {
  const byCoin = new Map<string, FundingQuote[]>();
  for (const quote of quotes) {
    if (!Number.isFinite(quote.time) || !Number.isFinite(quote.binanceTime) ||
      quote.binanceTime > quote.time || !Number.isFinite(quote.hlHourly) ||
      !Number.isFinite(quote.binanceEightHour)) throw new Error('Invalid funding quote');
    const coin = quote.coin.toUpperCase();
    byCoin.set(coin, [...(byCoin.get(coin) ?? []), quote]);
  }
  for (const rows of byCoin.values()) rows.sort((a, b) => a.time - b.time);
  const vetoed: FundingStudyTrade[] = [];
  const kept: FundingStudyTrade[] = [];
  let unclassified = 0;
  for (const trade of trades) {
    if (!Number.isFinite(trade.entryTime) || !Number.isFinite(trade.netR)) throw new Error('Invalid replay trade');
    const quote = byCoin.get(trade.coin.toUpperCase())?.filter((row) =>
      row.time <= trade.entryTime && trade.entryTime - row.time <= 8 * HOUR &&
      row.binanceTime <= trade.entryTime && trade.entryTime - row.binanceTime <= 8 * HOUR).at(-1);
    if (!quote) { unclassified++; continue; }
    const premium = quote.hlHourly * 8 - quote.binanceEightHour;
    const crowded = trade.side === 'long' ? premium >= PREMIUM_BAR : premium <= -PREMIUM_BAR;
    (crowded ? vetoed : kept).push(trade);
  }
  const veto = group(vetoed);
  const keep = group(kept);
  const gap = veto.meanR === null || keep.meanR === null ? null : keep.meanR - veto.meanR;
  const verdict = veto.episodes < 5 || keep.episodes < 5 ? 'insufficient-evidence'
    : gap !== null && gap >= 0.3 ? 'keep-for-forward-study' : 'kill';
  return { total: trades.length, unclassified, vetoed: veto, kept: keep,
    keptMinusVetoedR: gap, verdict };
}
