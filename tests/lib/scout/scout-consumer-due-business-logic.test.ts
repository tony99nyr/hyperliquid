import { describe, expect, it } from 'vitest';
import { actTriggerCutoffMs, isConsumerDue, lastConsumerRunMs } from '@/lib/scout/scout-consumer-due-business-logic';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const minAgo = (m: number) => NOW - m * 60_000;

describe('isConsumerDue', () => {
  it('runs when no earlier run is known', () => {
    expect(isConsumerDue({ now: NOW, lastRunAtMs: null, newActTriggers: 0 }).due).toBe(true);
  });

  it('runs on the 30-minute cadence and waits before it', () => {
    expect(isConsumerDue({ now: NOW, lastRunAtMs: minAgo(30), newActTriggers: 0 }).due).toBe(true);
    expect(isConsumerDue({ now: NOW, lastRunAtMs: minAgo(29), newActTriggers: 0 }).due).toBe(false);
  });

  it('runs after 10 minutes when a new act trigger waits, not sooner', () => {
    expect(isConsumerDue({ now: NOW, lastRunAtMs: minAgo(10), newActTriggers: 1 }).due).toBe(true);
    expect(isConsumerDue({ now: NOW, lastRunAtMs: minAgo(9), newActTriggers: 2 }).due).toBe(false);
  });
});

describe('lastConsumerRunMs', () => {
  it('a failed attempt after a stale heartbeat counts as the last run (no rerun every tick)', () => {
    const last = lastConsumerRunMs(minAgo(120), minAgo(5));
    expect(last).toBe(minAgo(5));
    expect(isConsumerDue({ now: NOW, lastRunAtMs: last, newActTriggers: 0 }).due).toBe(false);
  });

  it('uses whichever is known, and null when neither is', () => {
    expect(lastConsumerRunMs(minAgo(7), null)).toBe(minAgo(7));
    expect(lastConsumerRunMs(null, null)).toBeNull();
  });
});

describe('actTriggerCutoffMs', () => {
  it('uses the attempt stamp even when the heartbeat is later (a trigger during the run still counts)', () => {
    expect(actTriggerCutoffMs(minAgo(5), minAgo(8))).toBe(minAgo(8));
  });

  it('falls back to the heartbeat, and null when neither is known', () => {
    expect(actTriggerCutoffMs(minAgo(7), null)).toBe(minAgo(7));
    expect(actTriggerCutoffMs(null, null)).toBeNull();
  });
});
