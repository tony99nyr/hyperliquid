import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateAttempt,
  checkRateLimit,
  clearRateLimit,
  _resetRateLimits,
} from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';

describe('evaluateAttempt (PURE window logic)', () => {
  it('allows the first attempt and counts up', () => {
    const d = evaluateAttempt(undefined, 1000, 3, 60_000);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(2);
    expect(d.next.count).toBe(1);
  });

  it('blocks once the max is reached within the window', () => {
    let entry = evaluateAttempt(undefined, 0, 2, 60_000).next;
    entry = evaluateAttempt(entry, 1000, 2, 60_000).next; // 2nd, now at max
    const third = evaluateAttempt(entry, 2000, 2, 60_000);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it('resets after the window elapses', () => {
    const entry = evaluateAttempt(undefined, 0, 1, 1000).next; // at max
    expect(evaluateAttempt(entry, 500, 1, 1000).allowed).toBe(false); // within window
    const afterWindow = evaluateAttempt(entry, 1500, 1, 1000); // window elapsed
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.next.windowStart).toBe(1500);
  });
});

describe('checkRateLimit (stateful)', () => {
  beforeEach(() => _resetRateLimits());

  it('blocks a key after exceeding the limit and clears on success', () => {
    const key = 'login:1.2.3.4';
    let blocked = false;
    for (let i = 0; i < 12; i++) {
      if (!checkRateLimit(key, 8, 60_000).allowed) blocked = true;
    }
    expect(blocked).toBe(true);
    clearRateLimit(key);
    expect(checkRateLimit(key, 8, 60_000).allowed).toBe(true); // window reset
  });

  it('isolates separate keys', () => {
    checkRateLimit('a', 1, 60_000);
    expect(checkRateLimit('a', 1, 60_000).allowed).toBe(false);
    expect(checkRateLimit('b', 1, 60_000).allowed).toBe(true);
  });
});
