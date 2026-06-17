/**
 * Pins the popup's "LIVE needs a stronger confirm" invariant (pure): paper
 * Approve is always enabled; live Approve enables ONLY on the exact
 * "side sz coin" phrase (case-insensitive, trimmed).
 */

import { describe, it, expect } from 'vitest';
import {
  isApproveEnabled,
  liveConfirmPhrase,
  summarizeProposal,
} from '@/app/cockpit/components/approval-popup-helpers';
import type { PendingActionDisplay } from '@/types/cockpit';

const display: PendingActionDisplay = { coin: 'ETH', side: 'sell', sz: 1.5, estPx: 2000, stopPx: 1900, rationale: 'exit' };

describe('liveConfirmPhrase', () => {
  it('is "side sz coin" lowercased', () => {
    expect(liveConfirmPhrase(display)).toBe('sell 1.5 eth');
  });
});

describe('isApproveEnabled', () => {
  it('PAPER: always enabled (one-tap), even with empty input', () => {
    expect(isApproveEnabled('paper', display, '')).toBe(true);
  });
  it('LIVE: disabled until the exact phrase is typed', () => {
    expect(isApproveEnabled('live', display, '')).toBe(false);
    expect(isApproveEnabled('live', display, 'yes')).toBe(false);
    expect(isApproveEnabled('live', display, 'sell 1.5 eth')).toBe(true);
  });
  it('LIVE: case-insensitive + trims surrounding whitespace', () => {
    expect(isApproveEnabled('live', display, '  SELL 1.5 ETH  ')).toBe(true);
  });
  it('LIVE: a wrong size does not enable', () => {
    expect(isApproveEnabled('live', display, 'sell 2 eth')).toBe(false);
  });
});

describe('summarizeProposal', () => {
  it('renders side/size/coin + price + stop', () => {
    expect(summarizeProposal(display)).toBe('SELL 1.5 ETH @≈$2000 · stop $1900');
  });
  it('omits price/stop when absent', () => {
    expect(summarizeProposal({ coin: 'BTC', side: 'buy', sz: 0.1, rationale: 'x' })).toBe('BUY 0.1 BTC');
  });
});
