/**
 * ENFORCING Supabase realtime mock for cockpit hook/component tests.
 *
 * The previous test suite stubbed only the server-side fluent builder
 * (supabase.mock.ts). It modeled NONE of the realtime surface, so a topic-reuse
 * bug in `useRealtimeChannel` (chaining `.on('postgres_changes', …)` on an
 * already-SUBSCRIBED channel that `client.channel(topic)` handed back) sailed
 * through `pnpm test` and only crashed in the real browser.
 *
 * This mock reproduces the two real constraints that made the crash possible:
 *
 *   (a) A channel THROWS the real error
 *       `cannot add 'postgres_changes' callbacks … after subscribe()` if `.on()`
 *       is called after `.subscribe()`. (Mirrors @supabase/realtime-js.)
 *
 *   (b) `client.channel(topic)` returns the SAME channel object for a repeated
 *       topic that is still registered (i.e. not yet removed). This is what made
 *       the old `rt:${table}:${sessionId}` scheme dangerous: a re-run got back a
 *       subscribed channel and then called `.on()` on it.
 *
 * With both modeled, a topic-reuse bug reproduces as a thrown error inside the
 * React effect during a jsdom mount — exactly the client-side crash class we
 * need `pnpm test` to catch BEFORE pushing.
 */

import { vi } from 'vitest';

type ChangeCallback = (payload: { new?: unknown; old?: unknown }) => void;
type StatusCallback = (status: string) => void;

export interface MockRealtimeChannel {
  topic: string;
  on: (event: string, filter: unknown, cb: ChangeCallback) => MockRealtimeChannel;
  subscribe: (cb?: StatusCallback) => MockRealtimeChannel;
  /** True once .subscribe() has been called. */
  subscribed: boolean;
  /** True once removeChannel() has run for this channel. */
  removed: boolean;
  /** Registered postgres_changes callbacks (for emitting test events). */
  _callbacks: ChangeCallback[];
}

export interface RealtimeBrowserMock {
  client: {
    from: ReturnType<typeof vi.fn>;
    channel: ReturnType<typeof vi.fn>;
    removeChannel: ReturnType<typeof vi.fn>;
  };
  /** Every channel ever created, in order (including topic-collisions). */
  channels: MockRealtimeChannel[];
  /** Topics passed to client.channel(), in order — assert uniqueness here. */
  requestedTopics: string[];
  /** Emit a postgres_changes event to all live channels matching a topic prefix. */
  emit(topicPrefix: string, payload: { new?: unknown; old?: unknown }): void;
  reset(): void;
}

const AFTER_SUBSCRIBE_ERROR =
  "cannot add 'postgres_changes' callbacks for realtime:%TOPIC% after subscribe()";

/**
 * Build an enforcing realtime browser-client mock.
 *
 * `initialFetch` is the result returned by the initial-snapshot query
 * (`from(table).select().eq().order().limit()`); defaults to an empty list.
 */
export function createRealtimeBrowserMock(
  initialFetch: { data?: unknown[]; error?: { message: string } | null } = { data: [], error: null },
): RealtimeBrowserMock {
  const channels: MockRealtimeChannel[] = [];
  const requestedTopics: string[] = [];
  // Topic → still-registered channel (constraint (b)). Cleared on removeChannel.
  const liveByTopic = new Map<string, MockRealtimeChannel>();

  function makeChannel(topic: string): MockRealtimeChannel {
    const channel: MockRealtimeChannel = {
      topic,
      subscribed: false,
      removed: false,
      _callbacks: [],
      on(_event, _filter, cb) {
        // CONSTRAINT (a): the real client throws if you add a postgres_changes
        // listener after subscribe().
        if (channel.subscribed) {
          throw new Error(AFTER_SUBSCRIBE_ERROR.replace('%TOPIC%', topic));
        }
        channel._callbacks.push(cb);
        return channel;
      },
      subscribe(cb) {
        channel.subscribed = true;
        cb?.('SUBSCRIBED');
        return channel;
      },
    };
    return channel;
  }

  const channel = vi.fn((topic: string) => {
    requestedTopics.push(topic);
    // CONSTRAINT (b): a repeated, still-registered topic returns the SAME object.
    const existing = liveByTopic.get(topic);
    if (existing && !existing.removed) return existing;
    const created = makeChannel(topic);
    channels.push(created);
    liveByTopic.set(topic, created);
    return created;
  });

  const removeChannel = vi.fn((ch: MockRealtimeChannel) => {
    ch.removed = true;
    if (liveByTopic.get(ch.topic) === ch) liveByTopic.delete(ch.topic);
    // Real client returns a thenable status; tests use fire-and-forget `void`.
    return Promise.resolve('ok');
  });

  // Minimal initial-snapshot builder: from(t).select().eq().order().limit() → result.
  const from = vi.fn(() => {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => Promise.resolve({ data: initialFetch.data ?? [], error: initialFetch.error ?? null }),
    };
    return builder;
  });

  return {
    client: { from, channel, removeChannel },
    channels,
    requestedTopics,
    emit(topicPrefix, payload) {
      for (const ch of channels) {
        if (!ch.removed && ch.subscribed && ch.topic.startsWith(topicPrefix)) {
          for (const cb of ch._callbacks) cb(payload);
        }
      }
    },
    reset() {
      channels.length = 0;
      requestedTopics.length = 0;
      liveByTopic.clear();
      from.mockClear();
      channel.mockClear();
      removeChannel.mockClear();
    },
  };
}
