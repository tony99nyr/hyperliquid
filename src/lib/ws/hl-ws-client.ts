/**
 * HL websocket client (I/O — CLIENT-SIDE ONLY). Connects to
 * wss://api.hyperliquid.xyz/ws using the browser-native WebSocket (NO `ws` npm
 * dep), subscribes to l2Book + trades + allMids for one coin, heartbeats, and
 * auto-reconnects with exponential backoff (re-subscribing on reconnect).
 *
 * ALL the market-data folding logic is in the PURE hl-ws-reducer; this file is
 * just transport: socket lifecycle + a subscribe/callback API + the current
 * snapshot. When the socket is unhealthy past a threshold the caller can spin up
 * the REST fallback (hl-rest-fallback.ts) which patches the SAME snapshot.
 *
 * This module is for `'use client'` consumers only (Vercel serverless can't hold
 * sockets — see ADR-0002). It guards against a missing WebSocket global so it is
 * import-safe on the server.
 */

import type { FeedStatus, LiveMarketState } from '@/types/market';
import { emptyMarketState, reduce, withStatus, type HlWsMessage } from './hl-ws-reducer';

const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws';
const HEARTBEAT_INTERVAL_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export type MarketStateListener = (state: LiveMarketState) => void;

export interface HlWsClientOptions {
  coin: string;
  /** Override the ws URL (tests). */
  url?: string;
  /** Inject a WebSocket implementation (tests); defaults to global WebSocket. */
  webSocketImpl?: typeof WebSocket;
  /** Heartbeat interval (ms). */
  heartbeatMs?: number;
}

/**
 * A single-coin live-market subscription. Construct, call `connect()`, and
 * `subscribe(listener)` for snapshot pushes. `getSnapshot()` returns the current
 * folded state. `disconnect()` tears down (no auto-reconnect after).
 */
export class HlWsClient {
  private readonly coin: string;
  private readonly url: string;
  private readonly WebSocketImpl: typeof WebSocket | undefined;
  private readonly heartbeatMs: number;

  private ws: WebSocket | null = null;
  private state: LiveMarketState;
  private readonly listeners = new Set<MarketStateListener>();

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closedByUser = false;

  constructor(opts: HlWsClientOptions) {
    this.coin = opts.coin.toUpperCase();
    this.url = opts.url ?? HL_WS_URL;
    this.WebSocketImpl =
      opts.webSocketImpl ??
      (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
    this.state = emptyMarketState(this.coin);
  }

  /** Current folded snapshot. */
  getSnapshot(): LiveMarketState {
    return this.state;
  }

  /** Subscribe to snapshot pushes. Returns an unsubscribe fn. */
  subscribe(listener: MarketStateListener): () => void {
    this.listeners.add(listener);
    listener(this.state); // push current immediately
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Open the socket (idempotent). */
  connect(): void {
    if (!this.WebSocketImpl) {
      // No WebSocket available (server import) — stay disconnected, fail-soft.
      this.setStatus('disconnected');
      return;
    }
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;

    this.closedByUser = false;
    this.setStatus('connecting');

    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.sendSubscriptions();
      this.startHeartbeat();
      this.setStatus('live');
    };
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);
    ws.onerror = () => {
      // The 'close' handler drives reconnection; just flag staleness here.
      this.setStatus('stale', true);
    };
    ws.onclose = () => {
      this.stopHeartbeat();
      if (!this.closedByUser) this.scheduleReconnect();
      else this.setStatus('disconnected');
    };
  }

  /** Close the socket and stop reconnecting. */
  disconnect(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  /**
   * Patch the snapshot from an external source (the REST fallback). Replaces the
   * book/price fields and marks the feed stale. Used when the socket is down.
   */
  applyFallback(patch: Partial<LiveMarketState>): void {
    this.state = { ...this.state, ...patch, stale: true, status: 'stale' };
    this.emit();
  }

  // --- internals ---

  private subscriptionMessages(): string[] {
    const subs = [
      { type: 'l2Book', coin: this.coin },
      { type: 'trades', coin: this.coin },
      { type: 'allMids' },
    ];
    return subs.map((s) => JSON.stringify({ method: 'subscribe', subscription: s }));
  }

  private sendSubscriptions(): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    for (const msg of this.subscriptionMessages()) this.ws.send(msg);
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let parsed: HlWsMessage;
    try {
      parsed = JSON.parse(raw) as HlWsMessage;
    } catch {
      return; // ignore non-JSON (e.g. pong frames)
    }
    if (parsed.channel === 'pong' || parsed.channel === 'subscriptionResponse') return;
    const next = reduce(this.state, parsed, Date.now());
    if (next !== this.state) {
      this.state = next;
      this.emit();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) {
        try {
          this.ws.send(JSON.stringify({ method: 'ping' }));
        } catch {
          /* ignore — close handler will reconnect */
        }
      }
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.setStatus('stale', true);
    const delay = Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.connect();
    }, delay);
  }

  private setStatus(status: FeedStatus, stale = status === 'stale'): void {
    const next = withStatus(this.state, status, stale);
    if (next !== this.state) {
      this.state = next;
      this.emit();
    }
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}
