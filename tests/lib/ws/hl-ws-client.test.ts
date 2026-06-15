import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HlWsClient } from '@/lib/ws/hl-ws-client';

/** Minimal fake WebSocket driving the client's lifecycle deterministically. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  url: string;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const makeClient = (over?: Partial<ConstructorParameters<typeof HlWsClient>[0]>) =>
  new HlWsClient({
    coin: 'ETH',
    url: 'wss://test',
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    heartbeatMs: 1000,
    ...over,
  });

describe('HlWsClient (I/O transport)', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('connects and sends l2Book + trades + allMids subscriptions on open', () => {
    const c = makeClient();
    c.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const subs = ws.sent.map((s) => JSON.parse(s));
    const types = subs.map((m) => m.subscription.type);
    expect(types).toEqual(['l2Book', 'trades', 'allMids']);
    expect(subs[0].subscription.coin).toBe('ETH');
    expect(c.getSnapshot().status).toBe('live');
  });

  it('folds inbound messages into the snapshot and notifies listeners', () => {
    const c = makeClient();
    const seen: number[] = [];
    c.subscribe((s) => {
      if (s.lastPx) seen.push(s.lastPx);
    });
    c.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message({ channel: 'trades', data: [{ coin: 'ETH', side: 'B', px: '2000', sz: '1', time: 1 }] });

    expect(c.getSnapshot().lastPx).toBe(2000);
    expect(seen).toContain(2000);
  });

  it('ignores pong / subscriptionResponse and non-JSON frames', () => {
    const c = makeClient();
    c.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    const before = c.getSnapshot();
    ws.message({ channel: 'pong' });
    ws.message({ channel: 'subscriptionResponse', data: {} });
    ws.onmessage?.({ data: 'not-json{' });
    expect(c.getSnapshot()).toEqual({ ...before, status: 'live' });
  });

  it('sends heartbeat pings on the interval', () => {
    const c = makeClient({ heartbeatMs: 1000 });
    c.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.sent.length = 0; // clear subscriptions
    vi.advanceTimersByTime(2500);
    const pings = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.method === 'ping');
    expect(pings.length).toBe(2);
  });

  it('reconnects with backoff on unexpected close and re-subscribes', () => {
    const c = makeClient();
    c.connect();
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();
    expect(c.getSnapshot().status).toBe('live');

    ws1.close(); // unexpected
    expect(c.getSnapshot().status).toBe('stale');

    // first backoff = 1000ms
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();
    const types = ws2.sent.map((s) => JSON.parse(s).subscription.type);
    expect(types).toEqual(['l2Book', 'trades', 'allMids']);
    expect(c.getSnapshot().status).toBe('live');
  });

  it('does not reconnect after an explicit disconnect()', () => {
    const c = makeClient();
    c.connect();
    FakeWebSocket.instances[0].open();
    c.disconnect();
    expect(c.getSnapshot().status).toBe('disconnected');
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('applyFallback patches the snapshot and flags stale', () => {
    const c = makeClient();
    c.applyFallback({ midPx: 2222, bids: [{ px: 2221, sz: 1 }], asks: [{ px: 2223, sz: 1 }] });
    const s = c.getSnapshot();
    expect(s.midPx).toBe(2222);
    expect(s.stale).toBe(true);
    expect(s.status).toBe('stale');
  });

  it('stays disconnected (fail-soft) when no WebSocket impl is available', () => {
    // Simulate a server-side import where no WebSocket global exists.
    const original = (globalThis as { WebSocket?: unknown }).WebSocket;
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
    try {
      const c = new HlWsClient({ coin: 'ETH', webSocketImpl: undefined });
      c.connect();
      expect(c.getSnapshot().status).toBe('disconnected');
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = original;
    }
  });
});
