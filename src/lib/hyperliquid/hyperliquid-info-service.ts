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
import { cachedHlRead } from './hl-cached-transport';

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

/**
 * HL's `userFillsByTime` page-caps at ~2000 rows per call. A single call that
 * returns this many is almost certainly truncated. Deep pagination (fetchAllFills)
 * walks past it; the completeness gate uses this constant to tell a single capped
 * page apart from a legitimately-deep accumulated history.
 */
export const HL_FILLS_PAGE_CAP = 2000;

/** Default hard ceiling on a deep fetch so a run can't fan out unbounded. */
const DEFAULT_MAX_FILLS = 12_000;

/** Courtesy delay between sequential pages to be polite to the public endpoint. */
const INTER_PAGE_DELAY_MS = 120;

export interface FetchAllFillsOptions {
  /** Oldest epoch-ms to fetch from (default: 365 days ago). */
  sinceMs?: number;
  /** Hard cap on accumulated fills before stopping (default DEFAULT_MAX_FILLS). */
  maxFills?: number;
}

export interface HlDeepFillsResult extends HlFillsResult {
  /**
   * True when the walk stopped at a bound (maxFills / page ceiling) rather than
   * exhausting the history — i.e. the tail may still be unseen. The completeness
   * gate treats this exactly like a single page-capped result (cannot be a clean A).
   */
  truncated: boolean;
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
    // Cross-instance Data Cache (~25s) + in-flight coalescing keyed by address:
    // leader/own position polls across all Vercel instances collapse to ~1
    // upstream HL fetch per address per window. Per-instance Map + fail-soft wrap.
    const raw = await cachedHlRead('clearinghouse', [address], async () => {
      const body = await hlInfoPost<RawClearinghouseState>({
        type: 'clearinghouseState',
        user: address,
      });
      // Soft-fail guard: HL can return `{}` / a garbage body with HTTP 200 on a
      // hiccup. A REAL account ALWAYS carries a `marginSummary` (with at least an
      // `accountValue`), even when totally flat (no positions, zero value). So we
      // key "soft-failed" on the ABSENCE of that sentinel — NOT on zero
      // value/positions — to avoid rejecting a legitimately-empty account. THROW
      // on absence so `unstable_cache` doesn't pin emptiness for the ~25s window.
      if (!body || typeof body !== 'object' || body.marginSummary?.accountValue === undefined) {
        throw new Error('clearinghouseState empty: soft failure (no marginSummary)');
      }
      return body;
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
      .map(mapRawFill)
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

/** Map one raw HL fill row to the normalized HlFill. PURE. */
function mapRawFill(f: Record<string, unknown>): HlFill {
  return {
    coin: String(f.coin ?? ''),
    side: f.side === 'B' || f.side === 'buy' ? ('buy' as const) : ('sell' as const),
    px: num(f.px),
    sz: num(f.sz),
    time: num(f.time),
    closedPnl: numOrNull(f.closedPnl),
    dir: typeof f.dir === 'string' ? f.dir : null,
  };
}

/** Stable dedup key for a fill (HL may overlap rows across windows). */
function fillKey(f: Record<string, unknown>): string {
  // Prefer the strongest unique ids HL provides; fall back to value tuple.
  const id = f.hash ?? f.tid ?? `${String(f.oid ?? '')}|${String(f.time ?? '')}`;
  return `${String(id)}|${String(f.time ?? '')}|${String(f.coin ?? '')}|${String(f.px ?? '')}|${String(f.sz ?? '')}|${String(f.dir ?? '')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deep-paginate a wallet's FULL fill history (read-only). HL's `userFillsByTime`
 * returns fills ASCENDING by time and page-caps at ~`HL_FILLS_PAGE_CAP`; this walks
 * time windows FORWARD (cursor = last fill time + 1) accumulating + de-duplicating
 * until a page returns < the cap (history exhausted), `maxFills` is reached, or a
 * page-count ceiling is hit.
 *
 * Ported from the iamrossi wallet-rating backfill (`scripts/analysis/wallet-rating/
 * backfill-fills.ts` `fetchFills()`): forward cursor, `< PAGE_SIZE` stop, no-progress
 * guard, dedup, time sort. Used by the analyze-traders grader so the completeness
 * gate evaluates real depth instead of a single capped page.
 *
 * Pages are inherently sequential (each depends on the previous window's last
 * time). Fail-soft: a page error returns whatever was accumulated so far.
 *
 * @returns fills most-recent first, plus `truncated` = stopped at a bound (tail
 *   may be unseen) rather than exhausting the history.
 */
export async function fetchAllFills(
  rawAddress: string,
  opts: FetchAllFillsOptions = {},
): Promise<HlDeepFillsResult> {
  const address = normalizeHlAddress(rawAddress);
  if (!isValidHlAddress(address)) {
    return {
      address,
      fills: [],
      fetchedAt: Date.now(),
      stale: false,
      truncated: false,
      error: 'Invalid Hyperliquid address',
    };
  }

  const sinceMs = opts.sinceMs ?? Date.now() - 365 * 24 * 60 * 60 * 1000;
  const maxFills = Math.max(HL_FILLS_PAGE_CAP, Math.floor(opts.maxFills ?? DEFAULT_MAX_FILLS));
  // Ceiling on pages so a pathological account can't loop forever; enough to
  // cover maxFills at the page cap plus a margin.
  const maxPages = Math.ceil(maxFills / HL_FILLS_PAGE_CAP) + 2;

  const seen = new Set<string>();
  const accumulated: HlFill[] = [];
  let cursor = sinceMs;
  let truncated = false;
  let lastError: string | undefined;

  try {
    for (let page = 0; page < maxPages; page++) {
      const batch = await hlInfoPost<Array<Record<string, unknown>>>({
        type: 'userFillsByTime',
        user: address,
        startTime: cursor,
      });
      const rows = batch ?? [];
      if (rows.length === 0) break;

      let maxTime = cursor;
      for (const row of rows) {
        const key = fillKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        accumulated.push(mapRawFill(row));
        const t = num(row.time);
        if (t > maxTime) maxTime = t;
      }

      // Exhausted: a short page means there's nothing after this window.
      if (rows.length < HL_FILLS_PAGE_CAP) break;
      // No forward progress (all rows at/<= cursor) — avoid an infinite loop.
      if (maxTime <= cursor) break;

      if (accumulated.length >= maxFills) {
        truncated = true;
        break;
      }
      cursor = maxTime + 1;
      if (page === maxPages - 1) truncated = true;
      await sleep(INTER_PAGE_DELAY_MS);
    }
  } catch (err) {
    // Fail-soft: keep what we have, but flag the result as potentially truncated.
    lastError = extractErrorMessage(err);
    truncated = true;
  }

  accumulated.sort((a, b) => b.time - a.time);
  const fills = accumulated.length > maxFills ? accumulated.slice(0, maxFills) : accumulated;

  return {
    address,
    fills,
    fetchedAt: Date.now(),
    stale: false,
    truncated,
    ...(lastError ? { error: lastError } : {}),
  };
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

/**
 * Fetch all current mid prices keyed by coin (HL `allMids`). Used to
 * mark-to-market open positions for the Performance view. Returns an
 * upper-cased coin → number map; throws on failure so the caller can fail-soft.
 */
export async function fetchAllMids(): Promise<Record<string, number>> {
  // Single shared key, cross-instance Data-Cached ~10s + coalesced: every
  // Performance-view mark-to-market across all instances rides one HL fetch per
  // 10s window. Throws on failure so callers can fail-soft (posture unchanged).
  const out = await cachedHlRead('allMids', ['all'], async () => {
    const raw = await hlInfoPost<Record<string, string>>({ type: 'allMids' });
    const mids: Record<string, number> = {};
    for (const [coin, px] of Object.entries(raw ?? {})) {
      const n = num(px);
      if (n > 0) mids[coin.trim().toUpperCase()] = n;
    }
    // Soft-fail guard: HL can return `{}` / a garbage body with HTTP 200 on a
    // hiccup. `allMids` for a live exchange is NEVER legitimately empty, so an
    // empty parse means a soft failure — THROW so `unstable_cache` doesn't pin
    // emptiness for the ~10s window. The caller fail-soft handles the rejection.
    if (Object.keys(mids).length === 0) {
      throw new Error('allMids empty: soft failure (no mids returned)');
    }
    return mids;
  });
  return out;
}
