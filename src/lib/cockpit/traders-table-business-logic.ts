/**
 * PURE sort/filter/eligibility logic for the trader table (fixture-testable).
 *
 * The operator browses a wide rated pool and narrows it by sorting on the trade/
 * profit/risk story columns and filtering. Per the review (B3) we do NOT hard-cut
 * on a numeric threshold — under-sampled names are SHOWN but badged (confidence),
 * and sort/filter does the narrowing. Nulls always sort last (an absent metric
 * isn't "the smallest").
 */

import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';

export type SortKey =
  | 'composite'
  | 'copyability'
  | 'totalReturn'
  | 'aggregatePnlUsd'
  | 'winRate'
  | 'medianHoldHours'
  | 'maxDrawdownFrac'
  | 'reserveMultiple'
  | 'worstLossVsMedianWin'
  | 'medianAddDepth'
  | 'majorsShare'
  | 'nFills';

export type SortDir = 'asc' | 'desc';

/** Copyability verdict (the on-demand vet result, persisted in trader_evaluations). */
export type Verdict = 'follow' | 'caution' | 'avoid';
/** Higher = more copyable. Used for the Copyability column sort (nulls = unvetted, last). */
export const VERDICT_RANK: Record<Verdict, number> = { follow: 3, caution: 2, avoid: 1 };

/** The slice of a persisted evaluation the table needs (joined in by address). */
export interface TraderEvalLite {
  verdict: Verdict;
  addsPerTrip: number | null;
  roundTrips: number | null;
}

/** Accessor injected by the component (the eval map lives in a hook). */
export type GetEval = (address: string) => TraderEvalLite | null;

/** Min fills for a confident read (mirrors the INSUFFICIENT_HISTORY gate). */
export const MIN_FILLS_FOR_CONFIDENCE = 50;

function sortValue(row: TopTraderRow, key: SortKey): number | null {
  if (key === 'composite') return row.composite;
  const m = row.metrics;
  switch (key) {
    case 'totalReturn': return m.totalReturn ?? null;
    case 'aggregatePnlUsd': return m.aggregatePnlUsd;
    case 'winRate': return m.winRate;
    case 'medianHoldHours': return m.medianHoldHours;
    case 'maxDrawdownFrac': return m.maxDrawdownFrac;
    case 'reserveMultiple': return m.reserveMultiple ?? null;
    case 'worstLossVsMedianWin': return m.worstLossVsMedianWin;
    case 'medianAddDepth': return m.medianAddDepth ?? null;
    case 'majorsShare': return m.majorsShare ?? null;
    case 'nFills': return m.nFills;
    default: return null;
  }
}

/** Sort a copy of rows by key/dir. Nulls always last, regardless of direction.
 *  `getEval` supplies the value for the 'copyability' key (verdict rank). */
export function sortTraders(rows: TopTraderRow[], key: SortKey, dir: SortDir, getEval?: GetEval): TopTraderRow[] {
  const value = (r: TopTraderRow): number | null => {
    if (key === 'copyability') {
      const v = getEval?.(r.address)?.verdict;
      return v ? VERDICT_RANK[v] : null;
    }
    return sortValue(r, key);
  };
  return [...rows].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // a after b
    if (bv === null) return -1;
    return dir === 'asc' ? av - bv : bv - av;
  });
}

export interface TraderFilter {
  /** Only favorited traders (uses the isFavorite predicate). */
  favoritesOnly?: boolean;
  /** Only traders that touch our tradeable set (ETH/BTC/HYPE). */
  tradeableOnly?: boolean;
  /** Hide traders carrying a risk flag. */
  excludeRisk?: boolean;
  /** Only vault-backed names (the one persistent copy signal). */
  vaultOnly?: boolean;
  /** Hide under-sampled (thin-history) names. */
  excludeThin?: boolean;
  /** Only vetted traders with verdict=follow (the copyable shortlist). */
  followableOnly?: boolean;
  /** Hide vetted-avoid names (averagers / blow-up shapes). */
  hideAvoid?: boolean;
  /** Hide names with no closed-trip evidence (0 round-trips — verdict is vacuous). */
  hideNoEvidence?: boolean;
  /** Only traders that have a persisted copyability evaluation. */
  vettedOnly?: boolean;
  /** Minimum win rate (fraction 0-1). */
  minWinRate?: number | null;
  /** Maximum median hold (hours). */
  maxMedianHoldHours?: number | null;
  /** Case-insensitive substring on address / short / displayName. */
  search?: string;
}

/** True when the row has too few fills to grade confidently (badged, not cut). */
export function isThinHistory(row: TopTraderRow): boolean {
  const n = row.metrics.nFills;
  return n === null || n < MIN_FILLS_FOR_CONFIDENCE;
}

/** True when the wallet is vault-backed (the persistent copy signal). */
export function isVaultLed(row: TopTraderRow): boolean {
  return row.allFlags.includes('VAULT_LED');
}

/** Apply the filter. `isFavorite` is injected (the favorites set lives in a hook). */
export function filterTraders(
  rows: TopTraderRow[],
  filter: TraderFilter,
  isFavorite: (address: string) => boolean,
  getEval?: GetEval,
): TopTraderRow[] {
  const search = filter.search?.trim().toLowerCase() ?? '';
  return rows.filter((r) => {
    if (filter.favoritesOnly && !isFavorite(r.address)) return false;
    if (filter.tradeableOnly && !r.tradesTradeableCoin) return false;
    if (filter.excludeRisk && r.hasRisk) return false;
    if (filter.vaultOnly && !isVaultLed(r)) return false;
    if (filter.excludeThin && isThinHistory(r)) return false;
    if (filter.followableOnly || filter.hideAvoid || filter.hideNoEvidence || filter.vettedOnly) {
      const ev = getEval?.(r.address) ?? null;
      if (filter.vettedOnly && ev === null) return false;
      if (filter.followableOnly && ev?.verdict !== 'follow') return false;
      if (filter.hideAvoid && ev?.verdict === 'avoid') return false;
      // "no evidence" = vetted but 0 closed round-trips (verdict passed vacuously).
      if (filter.hideNoEvidence && ev !== null && (ev.roundTrips ?? 0) === 0) return false;
    }
    if (filter.minWinRate != null && (r.metrics.winRate === null || r.metrics.winRate < filter.minWinRate)) return false;
    if (filter.maxMedianHoldHours != null && (r.metrics.medianHoldHours === null || r.metrics.medianHoldHours > filter.maxMedianHoldHours)) return false;
    if (search) {
      const hay = `${r.address} ${r.short} ${r.displayName ?? ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}
