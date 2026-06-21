import { describe, it, expect } from 'vitest';
import { scoutStats, statusMeta } from '@/app/cockpit/components/scout-panel-helpers';
import type { Hypothesis } from '@/types/cockpit';

function h(status: Hypothesis['status']): Hypothesis {
  return { id: status + Math.random(), sessionId: 's', createdAt: 0, statement: 'x', status, resolvedAt: null, resolutionNote: null };
}

describe('scoutStats', () => {
  it('counts by status and computes win-rate over decided theses', () => {
    const s = scoutStats([h('open'), h('open'), h('confirmed'), h('confirmed'), h('confirmed'), h('invalidated'), h('resolved')]);
    expect(s).toMatchObject({ open: 2, wins: 3, losses: 1, resolved: 1 });
    expect(s.winRate).toBeCloseTo(0.75, 6); // 3 / (3+1)
  });

  it('winRate is null when nothing is decided', () => {
    expect(scoutStats([h('open'), h('resolved')]).winRate).toBeNull();
  });
});

describe('statusMeta', () => {
  it('maps statuses to short trade-desk labels', () => {
    expect(statusMeta('confirmed').label).toBe('WIN');
    expect(statusMeta('invalidated').label).toBe('LOSS');
    expect(statusMeta('open').label).toBe('OPEN');
    expect(statusMeta('resolved').label).toBe('FLAT');
  });
});
