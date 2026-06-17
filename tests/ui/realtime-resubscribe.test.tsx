/**
 * REGRESSION: realtime re-subscribe race (the /cockpit client-side crash).
 *
 * The deployed cockpit threw, uncaught, on load:
 *   "cannot add 'postgres_changes' callbacks for realtime:rt:analysis_log:<id>
 *    after subscribe()"
 * Root cause: useRealtimeChannel used a topic that was NOT unique per effect run
 * (`rt:${table}:${sessionId}`). Supabase's client.channel(topic) returns an
 * EXISTING channel for a still-registered topic; teardown's removeChannel() is
 * async/fire-and-forget. When the effect re-ran (sessionId null→id, id→id
 * re-run, StrictMode double-invoke) before removal landed, .on() was chained on
 * an already-subscribed channel and threw — crashing render.
 *
 * These tests use the ENFORCING realtime mock (tests/mocks/supabase-realtime.mock.ts)
 * which models BOTH real constraints: (a) .on() after .subscribe() throws, and
 * (b) channel(topic) returns the same object for a still-registered topic. That
 * combination reproduces the crash in jsdom.
 *
 * CONFIRMED: against the OLD topic scheme (`rt:${table}:${sessionId}`) the
 * "id→id re-run" and CockpitClient mount cases THROW here; with the unique-per-run
 * topic fix they pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useState } from 'react';
import { createRealtimeBrowserMock } from '../mocks/supabase-realtime.mock';

// --- Mock the browser Supabase client to the enforcing realtime mock. -------
const realtime = createRealtimeBrowserMock({ data: [], error: null });
vi.mock('@/lib/cockpit/supabase-browser', () => ({
  getBrowserClient: () => realtime.client,
}));

// --- Stub the HL websocket + candle fetch so CockpitClient mounts cleanly. --
vi.mock('@/lib/ws/hl-ws-client', () => {
  class FakeHlWsClient {
    private listener: ((s: unknown) => void) | null = null;
    constructor(public opts: { coin: string }) {}
    subscribe(l: (s: unknown) => void) {
      this.listener = l;
      return () => {
        this.listener = null;
      };
    }
    connect() {}
    disconnect() {}
    getSnapshot() {
      return {
        coin: this.opts.coin,
        bids: [],
        asks: [],
        recentTrades: [],
        lastPx: null,
        status: 'connecting',
        stale: false,
        bookUpdatedAt: null,
      };
    }
  }
  return { HlWsClient: FakeHlWsClient };
});

vi.mock('@/lib/hyperliquid/candle-service', () => ({
  fetchCandles: () => Promise.resolve({ candles: [], error: null }),
  fetchMultiTimeframeCandles: () => Promise.resolve({}),
}));

// Now import the units under test (after mocks are registered).
import { useRealtimeChannel } from '@/hooks/useRealtimeChannel';
import CockpitClient from '@/app/cockpit/CockpitClient';

beforeEach(() => {
  realtime.reset();
  // useActiveSession polls /api/cockpit/active-session — keep it inert so the
  // seeded server session drives the test deterministically.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response)),
  );
});

/** A tiny harness that drives sessionId transitions through the hook. */
function Harness({ sessionId }: { sessionId: string | null }) {
  const { subscribed, error } = useRealtimeChannel<{ id: string; createdAt: number }>({
    table: 'analysis_log',
    sessionId,
    map: (r) => ({ id: String(r.id), createdAt: Number(r.created_at ?? 0) }),
    compare: (a, b) => b.createdAt - a.createdAt,
  });
  return (
    <div data-testid="harness" data-subscribed={String(subscribed)} data-error={error ?? ''}>
      hook ok
    </div>
  );
}

describe('useRealtimeChannel re-subscribe race', () => {
  it('does not throw across null → id → (id re-run) transitions', async () => {
    // null → id
    const { rerender } = render(<Harness sessionId={null} />);
    await act(async () => {
      rerender(<Harness sessionId="sess-1" />);
    });
    // id → id RE-RUN: same sessionId but the effect re-runs (e.g. a limit/order
    // prop churn or a remount). With the OLD scheme this is the killer: the new
    // run gets back the still-registered, already-subscribed channel and .on()
    // throws. Force a fresh effect run by toggling the key.
    await act(async () => {
      rerender(<Harness key="remount" sessionId="sess-1" />);
    });

    expect(screen.getByTestId('harness').getAttribute('data-error')).toBe('');
    // Every requested topic must be UNIQUE (the structural guarantee).
    const topics = realtime.requestedTopics;
    expect(new Set(topics).size).toBe(topics.length);
    // And no channel was ever handed back a second time (constraint (b) never hit).
    expect(realtime.channels.length).toBe(topics.length);
  });

  it('reproduces a rapid remount loop without throwing', async () => {
    function Looper() {
      const [n, setN] = useState(0);
      return (
        <div>
          <button data-testid="bump" onClick={() => setN((x) => x + 1)}>
            bump
          </button>
          <Harness key={n} sessionId="sess-loop" />
        </div>
      );
    }
    render(<Looper />);
    const btn = screen.getByTestId('bump');
    // Each click remounts Harness → fresh subscribe effect while the prior
    // channel's removeChannel() is still in flight (fire-and-forget).
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        btn.click();
      });
    }
    expect(screen.getByTestId('harness').getAttribute('data-error')).toBe('');
  });
});

describe('CockpitClient mounts every realtime island without crashing', () => {
  it('mounts with a session (all panels subscribe) and survives a session re-bind', async () => {
    // Seed an active server session so ALL session-scoped islands subscribe
    // (Health/Context/Hypotheses/Analysis/Position/SafeExit/Approval/RealtimeStatus).
    const session = {
      id: 'sess-cockpit',
      title: 'regression',
      mode: 'paper' as const,
      status: 'active' as const,
      leaderAddress: null,
      createdAt: 0,
    };

    let rerender: (ui: React.ReactElement) => void = () => {};
    await act(async () => {
      const r = render(
        <CockpitClient
          mode="paper"
          session={session}
          leaderAddress={null}
          leaderPositions={[]}
        />,
      );
      rerender = r.rerender;
    });

    // The cockpit rendered (header present) — no uncaught throw during mount.
    expect(screen.getByTestId('cockpit-topbar')).toBeTruthy();

    // Re-bind to a NEW session id: every island's hook re-runs its subscribe
    // effect while prior channels are still being removed. This is the exact
    // production trigger; it must not throw.
    await act(async () => {
      rerender(
        <CockpitClient
          mode="paper"
          session={{ ...session, id: 'sess-cockpit-2' }}
          leaderAddress={null}
          leaderPositions={[]}
        />,
      );
    });

    expect(screen.getByTestId('cockpit-topbar')).toBeTruthy();
    // All topics requested across all islands + both bindings must be unique.
    const topics = realtime.requestedTopics;
    expect(topics.length).toBeGreaterThan(0);
    expect(new Set(topics).size).toBe(topics.length);
  });
});
