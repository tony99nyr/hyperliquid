import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Orderbook from '@/app/cockpit/components/Orderbook';

const book = {
  bids: [
    { px: 100, sz: 1 },
    { px: 99, sz: 2 },
  ],
  asks: [
    { px: 101, sz: 1 },
    { px: 102, sz: 3 },
  ],
  status: 'live' as const,
  stale: false,
};

describe('Orderbook', () => {
  it('renders bid + ask rows from the override book', () => {
    render(<Orderbook coin="ETH" stateOverride={book} />);
    expect(screen.getAllByTestId('ob-bid-row')).toHaveLength(2);
    expect(screen.getAllByTestId('ob-ask-row')).toHaveLength(2);
  });

  it('computes the mid + spread from the book', () => {
    render(<Orderbook coin="ETH" stateOverride={book} />);
    expect(screen.getByTestId('ob-mid').textContent).toBe('$100.5');
    expect(screen.getByTestId('ob-spread-val').textContent).toBe('$1');
  });

  it('shows a live status when not stale', () => {
    render(<Orderbook coin="ETH" stateOverride={book} />);
    expect(screen.getByTestId('orderbook').getAttribute('data-status')).toBe('live');
    expect(screen.getByTestId('ob-status').textContent).toBe('live');
  });

  it('shows the STALE badge when the REST fallback is driving', () => {
    render(<Orderbook coin="ETH" stateOverride={{ ...book, stale: true, status: 'stale' }} />);
    expect(screen.getByTestId('ob-stale-badge').textContent).toContain('STALE');
  });

  it('shows em-dashes when a side is empty (no mid/spread)', () => {
    render(<Orderbook coin="ETH" stateOverride={{ bids: [{ px: 100, sz: 1 }], asks: [], status: 'live', stale: false }} />);
    expect(screen.getByTestId('ob-mid').textContent).toBe('—');
    expect(screen.getByTestId('ob-spread-val').textContent).toBe('—');
  });
});
