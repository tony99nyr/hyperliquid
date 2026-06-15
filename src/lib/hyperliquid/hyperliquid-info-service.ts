/**
 * Hyperliquid public info-API client (READ-ONLY).
 *
 * Wraps Hyperliquid's public HTTP info endpoint to fetch open positions and
 * recent fills for ANY address — both the rated "leader" wallets and the
 * user's own wallet. No API key required; this is the same data the public
 * Hyperliquid UI shows.
 *
 * IMPORTANT: This service NEVER places trades. The Hyperliquid info API is a
 * read endpoint only — there is no order-placement code anywhere in this module
 * or the Wallet Copy-Monitor feature. It is decision-support, nothing more.
 *
 * Rate-limit posture: short in-process cache (default 15s) + fail-soft. If a
 * request fails or times out we return the last cached value (if any) so the
 * UI degrades gracefully rather than erroring.
 */

import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import type { L2Book, BookLevel } from './orderbook-match';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const REQUEST_TIMEOUT_MS = 8000;
const POSITION_CACHE_TTL_MS = 15_000;
const FILLS_CACHE_TTL_MS = 60_000;

// --- Public types (serializable; safe to pass RSC → client) ---

export interface HlPosition {
  coin: string;
  side: 'long' | 'short';
  /** Signed size in coin units (negative = short). */
  szi: number;
  /** Absolute size in coin units. */
  size: number;
  entryPx: number | null;
  positionValue: number;
  unrealizedPnl: number;
  returnOnEquity: number | null;
  leverage: number | null;
  leverageType: string | null;
  liquidationPx: number | null;
  marginUsed: number;
  /** Max leverage allowed for the asset, if reported. */
  maxLeverage: number | null;
}

export interface HlClearinghouseState {
  address: string;
  accountValueUsd: number;
  totalMarginUsed: number;
  totalNotionalPosition: number;
  withdrawableUsd: number;
  positions: HlPosition[];
  /** Epoch ms when this snapshot was fetched. */
  fetchedAt: number;
  /** True when served from cache after a live fetch failure. */
  stale: boolean;
  /** Set when the live fetch failed and a cached/empty value was returned. */
  error?: string;
}

export interface HlFill {
  coin: string;
  side: 'buy' | 'sell';
  px: number;
  sz: number;
  time: number;
  closedPnl: number | null;
  dir: string | null;
}

export interface HlFillsResult {
  address: string;
  fills: HlFill[];
  fetchedAt: number;
  stale: boolean;
  error?: string;
}

// --- Address validation ---

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isValidHlAddress(addr: string): boolean {
  return ADDRESS_RE.test(addr.trim());
}

export function normalizeHlAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

// --- Tiny in-process caches (per server instance) ---

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const positionCache = new Map<string, CacheEntry<HlClearinghouseState>>();
const fillsCache = new Map<string, CacheEntry<HlFillsResult>>();

// --- Low-level POST with timeout ---

async function hlInfoPost<T>(body: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`Hyperliquid info API returned ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// --- Parsing helpers (HL returns numbers as strings) ---

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

interface RawAssetPosition {
  position?: {
    coin?: string;
    szi?: string;
    entryPx?: string;
    positionValue?: string;
    unrealizedPnl?: string;
    returnOnEquity?: string;
    liquidationPx?: string;
    marginUsed?: string;
    maxLeverage?: number;
    leverage?: { type?: string; value?: number };
  };
}

interface RawClearinghouseState {
  assetPositions?: RawAssetPosition[];
  marginSummary?: {
    accountValue?: string;
    totalMarginUsed?: string;
    totalNtlPos?: string;
  };
  withdrawable?: string;
}

function parseClearinghouseState(address: string, raw: RawClearinghouseState): HlClearinghouseState {
  const positions: HlPosition[] = [];
  for (const ap of raw.assetPositions ?? []) {
    const pos = ap.position;
    if (!pos || !pos.coin) continue;
    const szi = num(pos.szi);
    if (szi === 0) continue;
    positions.push({
      coin: pos.coin,
      side: szi < 0 ? 'short' : 'long',
      szi,
      size: Math.abs(szi),
      entryPx: numOrNull(pos.entryPx),
      positionValue: num(pos.positionValue),
      unrealizedPnl: num(pos.unrealizedPnl),
      returnOnEquity: numOrNull(pos.returnOnEquity),
      leverage: numOrNull(pos.leverage?.value),
      leverageType: pos.leverage?.type ?? null,
      liquidationPx: numOrNull(pos.liquidationPx),
      marginUsed: num(pos.marginUsed),
      maxLeverage: numOrNull(pos.maxLeverage),
    });
  }
  const ms = raw.marginSummary ?? {};
  return {
    address,
    accountValueUsd: num(ms.accountValue),
    totalMarginUsed: num(ms.totalMarginUsed),
    totalNotionalPosition: num(ms.totalNtlPos),
    withdrawableUsd: num(raw.withdrawable),
    positions,
    fetchedAt: Date.now(),
    stale: false,
  };
}

// --- Public API ---

/**
 * Fetch a wallet's open positions + account value (clearinghouseState).
 * Cached for 15s. Fails soft: on error returns the last cached snapshot
 * (marked stale) or an empty snapshot with an `error` field.
 */
export async function fetchClearinghouseState(rawAddress: string): Promise<HlClearinghouseState> {
  const address = normalizeHlAddress(rawAddress);
  if (!isValidHlAddress(address)) {
    return {
      address,
      accountValueUsd: 0,
      totalMarginUsed: 0,
      totalNotionalPosition: 0,
      withdrawableUsd: 0,
      positions: [],
      fetchedAt: Date.now(),
      stale: false,
      error: 'Invalid Hyperliquid address',
    };
  }

  const cached = positionCache.get(address);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const raw = await hlInfoPost<RawClearinghouseState>({
      type: 'clearinghouseState',
      user: address,
    });
    const state = parseClearinghouseState(address, raw);
    positionCache.set(address, { value: state, expiresAt: Date.now() + POSITION_CACHE_TTL_MS });
    return state;
  } catch (err) {
    const message = extractErrorMessage(err);
    if (cached) {
      return { ...cached.value, stale: true, error: message };
    }
    return {
      address,
      accountValueUsd: 0,
      totalMarginUsed: 0,
      totalNotionalPosition: 0,
      withdrawableUsd: 0,
      positions: [],
      fetchedAt: Date.now(),
      stale: true,
      error: message,
    };
  }
}

/**
 * Fetch a wallet's recent fills (userFillsByTime). Used for the leader's
 * cycle/add history in the analytics overlay. Cached for 60s, fail-soft.
 *
 * @param lookbackMs How far back to fetch (default 14 days).
 * @param limit Max fills to return (most recent first), default 200.
 */
export async function fetchRecentFills(
  rawAddress: string,
  lookbackMs = 14 * 24 * 60 * 60 * 1000,
  limit = 200,
): Promise<HlFillsResult> {
  const address = normalizeHlAddress(rawAddress);
  if (!isValidHlAddress(address)) {
    return { address, fills: [], fetchedAt: Date.now(), stale: false, error: 'Invalid Hyperliquid address' };
  }

  const cached = fillsCache.get(address);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const startTime = Date.now() - lookbackMs;
    const raw = await hlInfoPost<Array<Record<string, unknown>>>({
      type: 'userFillsByTime',
      user: address,
      startTime,
    });
    const fills: HlFill[] = (raw ?? [])
      .map((f) => ({
        coin: String(f.coin ?? ''),
        side: f.side === 'B' || f.side === 'buy' ? ('buy' as const) : ('sell' as const),
        px: num(f.px),
        sz: num(f.sz),
        time: num(f.time),
        closedPnl: numOrNull(f.closedPnl),
        dir: typeof f.dir === 'string' ? f.dir : null,
      }))
      .sort((a, b) => b.time - a.time)
      .slice(0, limit);

    const result: HlFillsResult = { address, fills, fetchedAt: Date.now(), stale: false };
    fillsCache.set(address, { value: result, expiresAt: Date.now() + FILLS_CACHE_TTL_MS });
    return result;
  } catch (err) {
    const message = extractErrorMessage(err);
    if (cached) {
      return { ...cached.value, stale: true, error: message };
    }
    return { address, fills: [], fetchedAt: Date.now(), stale: true, error: message };
  }
}

// --- l2Book (order book) ---

interface RawL2Book {
  coin?: string;
  levels?: Array<Array<{ px?: string; sz?: string }>>;
  time?: number;
}

/**
 * Parse a raw HL `l2Book` response into the normalized `L2Book` shape the pure
 * matcher consumes: `bids` best (highest) first, `asks` best (lowest) first.
 * HL returns `levels: [bids, asks]` already in that order. PURE (exported for
 * unit testing).
 */
export function parseL2Book(coin: string, raw: RawL2Book): L2Book {
  const toLevels = (arr: Array<{ px?: string; sz?: string }> | undefined): BookLevel[] => {
    if (!Array.isArray(arr)) return [];
    const out: BookLevel[] = [];
    for (const lvl of arr) {
      const px = num(lvl?.px);
      const sz = num(lvl?.sz);
      if (px > 0 && sz > 0) out.push({ px, sz });
    }
    return out;
  };
  const levels = raw.levels ?? [];
  return {
    coin: raw.coin ?? coin.toUpperCase(),
    bids: toLevels(levels[0]),
    asks: toLevels(levels[1]),
  };
}

/**
 * Fetch a FRESH l2Book for a coin (NO cache — paper fills require a fresh book
 * each time, ADR-0001/0004). Throws on failure so the caller (paperFill) can
 * fail the intent rather than fill against stale/empty liquidity.
 */
export async function fetchL2Book(coin: string): Promise<L2Book> {
  const normCoin = coin.trim().toUpperCase();
  const raw = await hlInfoPost<RawL2Book>({ type: 'l2Book', coin: normCoin });
  return parseL2Book(normCoin, raw);
}
