/**
 * Pins the PURE approval-gate decision logic — the NO-AUTO-FIRE core. Only
 * 'approved' is true; 'rejected'/'expired'/'pending'/unknown are not; deadline
 * math is inclusive; only pending→decided transitions are legal.
 */

import { describe, it, expect } from 'vitest';
import {
  interpretStatus,
  isPastDeadline,
  outcomeToApproved,
  canTransition,
} from '@/lib/cockpit/approval-gate-business-logic';

describe('interpretStatus', () => {
  it('approved/rejected/expired are terminal', () => {
    expect(interpretStatus('approved')).toEqual({ kind: 'approved' });
    expect(interpretStatus('rejected')).toEqual({ kind: 'rejected' });
    expect(interpretStatus('expired')).toEqual({ kind: 'expired' });
  });
  it('pending / null / unknown keep polling (default NO until decided)', () => {
    expect(interpretStatus('pending').kind).toBe('keep-polling');
    expect(interpretStatus(null).kind).toBe('keep-polling');
    expect(interpretStatus(undefined).kind).toBe('keep-polling');
    expect(interpretStatus('weird').kind).toBe('keep-polling');
  });
});

describe('outcomeToApproved — ONLY approved is true', () => {
  it('approved → true', () => {
    expect(outcomeToApproved({ kind: 'approved' })).toBe(true);
  });
  it('everything else → false', () => {
    expect(outcomeToApproved({ kind: 'rejected' })).toBe(false);
    expect(outcomeToApproved({ kind: 'expired' })).toBe(false);
    expect(outcomeToApproved({ kind: 'keep-polling' })).toBe(false);
  });
});

describe('isPastDeadline', () => {
  it('false before the deadline', () => {
    expect(isPastDeadline(0, 5_000, 10_000)).toBe(false);
  });
  it('true at exactly the deadline (>=)', () => {
    expect(isPastDeadline(0, 10_000, 10_000)).toBe(true);
  });
  it('true after the deadline', () => {
    expect(isPastDeadline(0, 10_001, 10_000)).toBe(true);
  });
  it('a zero timeout expires immediately', () => {
    expect(isPastDeadline(0, 0, 0)).toBe(true);
  });
});

describe('canTransition — only pending→decided', () => {
  it('pending→approved / pending→rejected are legal', () => {
    expect(canTransition('pending', 'approved')).toBe(true);
    expect(canTransition('pending', 'rejected')).toBe(true);
  });
  it('a decided row cannot transition again', () => {
    expect(canTransition('approved', 'rejected')).toBe(false);
    expect(canTransition('rejected', 'approved')).toBe(false);
    expect(canTransition('expired', 'approved')).toBe(false);
  });
});
