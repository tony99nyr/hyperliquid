/**
 * Pins the Safe-Exit freshness messaging (pure): a fresh plan → "plan updated
 * Ns ago" (ok tone, uses Claude's exit); stale/absent → "Claude offline" warning
 * (danger tone, market-close fallback).
 */

import { describe, it, expect } from 'vitest';
import { formatAge, safeExitStatus } from '@/app/cockpit/components/safe-exit-button-helpers';
import type { SafeExitPlan } from '@/types/cockpit';

const plan: SafeExitPlan = {
  id: 'p1',
  sessionId: 's1',
  intent: { clientIntentId: 'i', sessionId: 's1', coin: 'ETH', side: 'sell', sz: 2, reduceOnly: true, createdAt: 0 },
  reasoning: null,
  isFallback: false,
  updatedAt: 0,
};

describe('formatAge', () => {
  it('seconds / minutes / hours', () => {
    expect(formatAge(5_000)).toBe('5s ago');
    expect(formatAge(120_000)).toBe('2m ago');
    expect(formatAge(7_200_000)).toBe('2h ago');
  });
});

describe('safeExitStatus', () => {
  it('fresh plan → ok tone, "plan updated …"', () => {
    const s = safeExitStatus(plan, true, 12_000);
    expect(s.tone).toBe('ok');
    expect(s.label).toContain('plan updated');
    expect(s.detail).toMatch(/Claude/);
  });
  it('stale plan → danger tone, Claude offline / market-close', () => {
    const s = safeExitStatus(plan, false, 600_000);
    expect(s.tone).toBe('danger');
    expect(s.label).toMatch(/offline|stale/i);
    expect(s.detail).toMatch(/market-close/i);
  });
  it('no plan → danger tone (fallback)', () => {
    const s = safeExitStatus(null, false, null);
    expect(s.tone).toBe('danger');
  });
});
