'use client';

/**
 * Live order-book hook (CLIENT-ONLY). Wraps the HlWsClient: constructs a
 * single-coin subscription on mount, folds snapshots into React state, and tears
 * down on unmount (or when the coin changes). Exposes the book, last price,
 * recent trades, and connection posture.
 *
 * The transport (socket lifecycle, reconnect, REST fallback patching) lives in
 * the I/O client; this hook is just the React bridge. Derivations (spread/mid)
 * are PURE helpers in orderbook-helpers.ts.
 */

import { useEffect, useMemo, useState } from 'react';
import { HlWsClient } from '@/lib/ws/hl-ws-client';
import { emptyMarketState } from '@/lib/ws/hl-ws-reducer';
import type { LiveMarketState, MarketBookLevel, MarketTrade } from '@/types/market';
import { effectiveLastPx, summarizeBook, type BookSummary } from './orderbook-helpers';

export interface HlOrderbookState {
  coin: string;
  bids: MarketBookLevel[];
  asks: MarketBookLevel[];
  book: BookSummary;
  lastPx: number | null;
  trades: MarketTrade[];
  /** True when the socket is live. */
  connected: boolean;
  /** True when serving degraded (REST fallback) data. */
  stale: boolean;
  /** Raw feed status for finer-grained UI. */
  status: LiveMarketState['status'];
}

export function useHlOrderbook(coin: string): HlOrderbookState {
  const normCoin = coin.trim().toUpperCase();
  const [state, setState] = useState<LiveMarketState>(() => emptyMarketState(normCoin));

  useEffect(() => {
    const client = new HlWsClient({ coin: normCoin });
    const unsubscribe = client.subscribe(setState);
    client.connect();
    return () => {
      unsubscribe();
      client.disconnect();
    };
  }, [normCoin]);

  const book = useMemo(() => summarizeBook(state.bids, state.asks), [state.bids, state.asks]);
  const lastPx = useMemo(() => effectiveLastPx(state), [state]);

  return {
    coin: state.coin,
    bids: state.bids,
    asks: state.asks,
    book,
    lastPx,
    trades: state.recentTrades,
    connected: state.status === 'live',
    stale: state.stale,
    status: state.status,
  };
}
