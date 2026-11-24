import { describe, expect, it } from 'vitest';
import { isConsumerDue } from '@/lib/scout/scout-consumer-due-business-logic';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const minAgo = (m: number) => NOW - m * 60_000;

describe('isConsumerDue', () => {
  it('runs when no scout-cycle heartbeat exists', () => {
    expect(isConsumerDue({ now: NOW, lastCycleAtMs: null, unconsumedActTriggers: 0 }).due).toBe(true);
  });

  it('runs on the 30-minute cadence and waits before it', () => {
    expect(isConsumerDue({ now: NOW, lastCycleAtMs: minAgo(30), unconsumedActTriggers: 0 }).due).toBe(true);
    expect(isConsumerDue({ now: NOW, lastCycleAtMs: minAgo(29), unconsumedActTriggers: 0 }).due).toBe(false);
  });

  it('runs after 10 minutes when an act trigger waits, not sooner', () => {
    expect(isConsumerDue({ now: NOW, lastCycleAtMs: minAgo(10), unconsumedActTriggers: 1 }).due).toBe(true);
    expect(isConsumerDue({ now: NOW, lastCycleAtMs: minAgo(9), unconsumedActTriggers: 2 }).due).toBe(false);
  });
});
