/**
 * Live market-data types — the FIRST realtime transport (HL websocket →
 * browser directly). These are high-frequency + ephemeral and are NEVER stored
 * in Supabase (that is the second transport; see ADR-0002). They live only in
 * client memory, folded by the PURE `hl-ws-reducer`.
 */

/** One order-book level: price + size resting at that price. */
export interface MarketBookLevel {
  px: number;
  sz: number;
}

/** A recent trade print off the `trades` feed. */
export interface MarketTrade {
  px: number;
  sz: number;
  side: 'buy' | 'sell';
  /** Epoch ms of the trade. */
  time: number;
}

/**
 * Connection posture of the live feed. `live` = socket healthy; `stale` = the
 * REST fallback is driving (degraded, flagged); `disconnected` = nothing yet.
 */
export type FeedStatus = 'connecting' | 'live' | 'stale' | 'disconnected';

/**
 * The folded live state for ONE coin. Produced purely by `hl-ws-reducer.reduce`
 * from a stream of ws messages (and patched by the REST fallback). The UI reads
 * this snapshot; it is the single source of truth for the live chart/orderbook.
 */
export interface LiveMarketState {
  coin: string;
  /** Best (highest) first. */
  bids: MarketBookLevel[];
  /** Best (lowest) first. */
  asks: MarketBookLevel[];
  /** Last trade / mid price seen (whichever updated most recently). */
  lastPx: number | null;
  /** Mid price from the `allMids` feed, if seen. */
  midPx: number | null;
  /** Most-recent-first ring of trade prints (bounded). */
  recentTrades: MarketTrade[];
  /** Epoch ms the orderbook was last updated. */
  bookUpdatedAt: number | null;
  /** Epoch ms any field was last updated. */
  updatedAt: number | null;
  /** Connection posture (driven by the I/O client, not the reducer). */
  status: FeedStatus;
  /** True when the data is being served by the REST fallback (degraded). */
  stale: boolean;
}
