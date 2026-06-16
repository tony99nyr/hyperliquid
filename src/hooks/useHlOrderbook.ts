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

/**
 * If the book hasn't ticked in this long while the socket still reports `live`,
 * treat the feed as silently stalled (a connected-but-frozen book is a real HL
 * failure mode the paper book-match must NOT trust — ADR-0003/0004).
 */
const BOOK_STALE_AFTER_MS = 12_000;
/** How often the watchdog re-evaluates book age. */
const WATCHDOG_TICK_MS = 3_000;

export interface HlOrderbookState {
  coin: string;
  bids: MarketBookLevel[];
  asks: MarketBookLevel[];
  book: BookSummary;
  lastPx: number | null;
  trades: MarketTrade[];
  /** True when the socket is live. */
  connected: boolean;
  /** True when serving degraded (REST fallback) data OR the book has gone silent. */
  stale: boolean;
  /** Raw feed status for finer-grained UI. */
  status: LiveMarketState['status'];
}

export function useHlOrderbook(coin: string): HlOrderbookState {
  const normCoin = coin.trim().toUpperCase();
  const [state, setState] = useState<LiveMarketState>(() => emptyMarketState(normCoin));
  // A connected-but-frozen book: socket says live but no tick within the window.
  // Computed in the watchdog effect (NOT render — Date.now() is impure) so it
  // re-evaluates on a timer even when no ws ticks arrive.
  const [silentlyStalled, setSilentlyStalled] = useState(false);

  // Switching coins must immediately drop the previous coin's book/price —
  // otherwise the old ETH levels linger until the new BTC socket ticks, which
  // reads as "the selector did nothing". Reset DURING render (React's
  // store-previous-prop-in-state idiom) so the swap is visible before the new
  // socket connects.
  const [renderedCoin, setRenderedCoin] = useState(normCoin);
  if (renderedCoin !== normCoin) {
    setRenderedCoin(normCoin);
    setState(emptyMarketState(normCoin));
    setSilentlyStalled(false);
  }

  useEffect(() => {
    const client = new HlWsClient({ coin: normCoin });
    const unsubscribe = client.subscribe(setState);
    client.connect();
    const evaluate = () => {
      const s = client.getSnapshot();
      setSilentlyStalled(
        s.status === 'live' &&
          s.bookUpdatedAt !== null &&
          Date.now() - s.bookUpdatedAt > BOOK_STALE_AFTER_MS,
      );
    };
    const watchdog = setInterval(evaluate, WATCHDOG_TICK_MS);
    return () => {
      clearInterval(watchdog);
      unsubscribe();
      client.disconnect();
      setSilentlyStalled(false);
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
    connected: state.status === 'live' && !silentlyStalled,
    stale: state.stale || silentlyStalled,
    status: state.status,
  };
}
