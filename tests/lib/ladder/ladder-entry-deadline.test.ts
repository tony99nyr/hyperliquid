import { describe, it, expect } from 'vitest';
import { entryGateClosed, type RungAction, type RungTriggerMeta } from '@/lib/ladder/ladder-types';

const NOW = 1_700_000_000_000;
const NONE = Symbol('no deadline');
const r = (action: RungAction, entryDeadlineMs: unknown = NONE) =>
  ({ action, triggerMeta: entryDeadlineMs === NONE ? null : ({ entryDeadlineMs } as RungTriggerMeta) });

describe('entryGateClosed', () => {
  it('is open when the rung carries no deadline', () => {
    expect(entryGateClosed(r('open'), NOW)).toBe(false);
    expect(entryGateClosed({ action: 'add', triggerMeta: { momentumConfirm: true } }, NOW)).toBe(false);
    expect(entryGateClosed({ action: 'open', triggerMeta: { entryDeadlineMs: undefined } }, NOW)).toBe(false);
  });
  it('closes AT the deadline and stays closed after it', () => {
    expect(entryGateClosed(r('open', NOW + 1), NOW)).toBe(false);
    expect(entryGateClosed(r('open', NOW), NOW)).toBe(true);
    expect(entryGateClosed(r('add', NOW - 1), NOW)).toBe(true);
  });
  it('fails closed on a malformed deadline', () => {
    // An explicit null is a present, invalid limit. Only an absent key means no deadline.
    for (const bad of [null, '2026-12-09T21:00:00Z', Number.NaN, Number.POSITIVE_INFINITY, 0, -5, {}]) {
      expect(entryGateClosed(r('open', bad), NOW)).toBe(true);
    }
  });
  it('never gates an exit or a stop move', () => {
    for (const action of ['reduce', 'close', 'stop_move'] as const) {
      expect(entryGateClosed(r(action, NOW - 1), NOW)).toBe(false);
      expect(entryGateClosed(r(action, 'garbage'), NOW)).toBe(false);
    }
  });
});
