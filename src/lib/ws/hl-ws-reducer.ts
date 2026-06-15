/**
 * HL websocket reducer (PURE). `reduce(state, message) → state` folds raw HL ws
 * messages (l2Book, trades, allMids) into a typed LiveMarketState. ALL the live
 * market-data logic lives here so it is fully fixture-testable with no socket
 * (the I/O client is a thin transport around this — see hl-ws-client.ts).
 *
 * HL ws message shapes (subscriptions):
 *  - l2Book : { channel:'l2Book',  data:{ coin, levels:[bids,asks], time } }
 *             each level = { px:string, sz:string, n:number }
 *  - trades : { channel:'trades',  data:[ { coin, side:'B'|'A', px, sz, time } ] }
 *  - allMids: { channel:'allMids', data:{ mids:{ COIN:'px', ... } } }
 */

import type {
  FeedStatus,
  LiveMarketState,
  MarketBookLevel,
  MarketTrade,
} from '@/types/market';

/** Max trade prints retained in the ring (most-recent-first). */
export const MAX_RECENT_TRADES = 50;
/** Max book levels retained per side. */
export const MAX_BOOK_LEVELS = 20;

/** A raw inbound ws message (post-JSON.parse). */
export interface HlWsMessage {
  channel?: string;
  data?: unknown;
}

/** Fresh empty state for a coin (status starts `connecting`). */
export function emptyMarketState(coin: string): LiveMarketState {
  return {
    coin: coin.toUpperCase(),
    bids: [],
    asks: [],
    lastPx: null,
    midPx: null,
    recentTrades: [],
    bookUpdatedAt: null,
    updatedAt: null,
    status: 'connecting',
    stale: false,
  };
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : NaN;
}

interface RawLevel {
  px?: number | string;
  sz?: number | string;
}

function parseLevels(raw: unknown): MarketBookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: MarketBookLevel[] = [];
  for (const lvl of raw) {
    const px = num((lvl as RawLevel)?.px);
    const sz = num((lvl as RawLevel)?.sz);
    if (Number.isFinite(px) && Number.isFinite(sz)) out.push({ px, sz });
    if (out.length >= MAX_BOOK_LEVELS) break;
  }
  return out;
}

function reduceL2Book(state: LiveMarketState, data: unknown, now: number): LiveMarketState {
  const d = data as { coin?: string; levels?: unknown; time?: number } | undefined;
  if (!d || !Array.isArray(d.levels)) return state;
  // Ignore updates for a different coin (defensive — client subscribes per coin).
  if (d.coin && d.coin.toUpperCase() !== state.coin) return state;

  const bids = parseLevels(d.levels[0]); // best (highest) first per HL
  const asks = parseLevels(d.levels[1]); // best (lowest) first per HL
  const ts = Number.isFinite(num(d.time)) ? num(d.time) : now;

  // Derive a mid from top-of-book when both sides present.
  const topBid = bids[0]?.px;
  const topAsk = asks[0]?.px;
  const mid = topBid !== undefined && topAsk !== undefined ? (topBid + topAsk) / 2 : state.midPx;

  return {
    ...state,
    bids,
    asks,
    midPx: mid,
    bookUpdatedAt: ts,
    updatedAt: now,
  };
}

function reduceTrades(state: LiveMarketState, data: unknown, now: number): LiveMarketState {
  if (!Array.isArray(data)) return state;
  const parsed: MarketTrade[] = [];
  let lastPx = state.lastPx;
  for (const t of data) {
    const row = t as { coin?: string; side?: string; px?: unknown; sz?: unknown; time?: unknown };
    if (row.coin && row.coin.toUpperCase() !== state.coin) continue;
    const px = num(row.px);
    const sz = num(row.sz);
    if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
    // HL trade side 'B' = aggressive buy, 'A' = aggressive sell.
    const side: MarketTrade['side'] = row.side === 'A' || row.side === 'sell' ? 'sell' : 'buy';
    const time = Number.isFinite(num(row.time)) ? num(row.time) : now;
    parsed.push({ px, sz, side, time });
    lastPx = px;
  }
  if (parsed.length === 0) return state;

  // Newest first: incoming batch (already chronological) reversed, then prior.
  const merged = [...parsed.reverse(), ...state.recentTrades].slice(0, MAX_RECENT_TRADES);
  return {
    ...state,
    recentTrades: merged,
    lastPx,
    updatedAt: now,
  };
}

function reduceAllMids(state: LiveMarketState, data: unknown, now: number): LiveMarketState {
  const mids = (data as { mids?: Record<string, unknown> } | undefined)?.mids;
  if (!mids || typeof mids !== 'object') return state;
  // HL keys allMids by coin symbol.
  const raw = mids[state.coin] ?? mids[state.coin.toUpperCase()];
  const mid = num(raw);
  if (!Number.isFinite(mid)) return state;
  return {
    ...state,
    midPx: mid,
    // Use mid as the last price only if no trade has set it yet.
    lastPx: state.lastPx ?? mid,
    updatedAt: now,
  };
}

/**
 * Fold one ws message into the state. Unknown channels and malformed payloads
 * return the state unchanged (fail-soft). `now` is injected so the reducer stays
 * pure/deterministic in tests; production passes Date.now().
 */
export function reduce(
  state: LiveMarketState,
  message: HlWsMessage,
  now: number = Date.now(),
): LiveMarketState {
  switch (message.channel) {
    case 'l2Book':
      return reduceL2Book(state, message.data, now);
    case 'trades':
      return reduceTrades(state, message.data, now);
    case 'allMids':
      return reduceAllMids(state, message.data, now);
    default:
      return state;
  }
}

/** Set the connection status / staleness (driven by the I/O client). PURE. */
export function withStatus(
  state: LiveMarketState,
  status: FeedStatus,
  stale: boolean = status === 'stale',
): LiveMarketState {
  return { ...state, status, stale };
}
