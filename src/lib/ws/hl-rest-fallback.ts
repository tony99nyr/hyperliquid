/**
 * REST fallback for the live feed (I/O — CLIENT-SIDE). When the websocket is
 * down past a threshold, poll the public `/info` endpoint for the l2Book + mid
 * price on an interval and patch the (degraded, flagged-stale) snapshot. This is
 * a graceful-degradation path, NOT the primary transport — the ws client is.
 *
 * Pure parsing is shared with the reducer's level shape; this file is the
 * polling transport. It calls a `patch` callback (typically HlWsClient.
 * applyFallback) so the UI keeps rendering from a single snapshot source.
 */

import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import type { LiveMarketState, MarketBookLevel } from '@/types/market';

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_POLL_MS = 5_000;
const MAX_BOOK_LEVELS = 20;

export type FallbackPatch = (patch: Partial<LiveMarketState>) => void;

export interface RestFallbackOptions {
  coin: string;
  /** Poll interval (ms). */
  pollMs?: number;
  /** Override the info URL (tests). */
  url?: string;
  /** Inject fetch (tests); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : NaN;
}

function parseLevels(raw: unknown): MarketBookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: MarketBookLevel[] = [];
  for (const lvl of raw) {
    const px = num((lvl as { px?: unknown })?.px);
    const sz = num((lvl as { sz?: unknown })?.sz);
    if (Number.isFinite(px) && Number.isFinite(sz)) out.push({ px, sz });
    if (out.length >= MAX_BOOK_LEVELS) break;
  }
  return out;
}

/**
 * Build a snapshot patch from a raw `/info` l2Book response. PURE — exported for
 * unit testing without polling. Returns null when the payload is unusable.
 */
export function buildFallbackPatch(
  coin: string,
  rawL2Book: unknown,
  now: number,
): Partial<LiveMarketState> | null {
  const d = rawL2Book as { coin?: string; levels?: unknown[]; time?: number } | undefined;
  if (!d || !Array.isArray(d.levels)) return null;
  if (d.coin && d.coin.toUpperCase() !== coin.toUpperCase()) return null;

  const bids = parseLevels(d.levels[0]);
  const asks = parseLevels(d.levels[1]);
  const topBid = bids[0]?.px;
  const topAsk = asks[0]?.px;
  const midPx = topBid !== undefined && topAsk !== undefined ? (topBid + topAsk) / 2 : null;

  return {
    bids,
    asks,
    midPx,
    lastPx: midPx,
    bookUpdatedAt: Number.isFinite(num(d.time)) ? num(d.time) : now,
    updatedAt: now,
    stale: true,
    status: 'stale',
  };
}

/**
 * Polls `/info` l2Book on an interval, pushing patches via `patch`. Call
 * `start()` when the socket has been down past your threshold and `stop()` once
 * it recovers.
 */
export class HlRestFallback {
  private readonly coin: string;
  private readonly pollMs: number;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly patch: FallbackPatch;

  constructor(opts: RestFallbackOptions, patch: FallbackPatch) {
    this.coin = opts.coin.toUpperCase();
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.url = opts.url ?? HL_INFO_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.patch = patch;
  }

  /** Begin polling (idempotent). Fires one immediate poll, then on interval. */
  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.pollMs);
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll cycle. Fail-soft: errors are swallowed (the feed stays stale). */
  async pollOnce(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'l2Book', coin: this.coin }),
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`Hyperliquid info API returned ${res.status}`);
      const raw = await res.json();
      const patch = buildFallbackPatch(this.coin, raw, Date.now());
      if (patch) this.patch(patch);
    } catch (err) {
      // Degraded path — keep going, just log. The UI already shows stale.
      void extractErrorMessage(err);
    } finally {
      clearTimeout(timeout);
    }
  }
}
