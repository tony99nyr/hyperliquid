import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import OpenPositionsPanel from '@/app/cockpit/components/OpenPositionsPanel';
import { ReadOnlyProvider } from '@/app/cockpit/read-only-context';
import type { PositionRow } from '@/hooks/realtime-row-mappers';

const position: PositionRow = {
  id: 'ETH', sessionId: 's', coin: 'ETH', side: 'long', sz: 1, avgEntryPx: 1700,
  realizedPnlUsd: 0, feesPaidUsd: 0, leverage: 5, updatedAt: 0,
};

const panel = () => (
  <OpenPositionsPanel sessionId={null} positionsOverride={{ positions: [position], latestPnlByCoin: {} }} />
);

describe('read-only viewer (OpenPositionsPanel)', () => {
  it('a viewer sees the position but no order controls', () => {
    render(<ReadOnlyProvider value={true}>{panel()}</ReadOnlyProvider>);
    const row = screen.getByTestId('position-row');
    expect(within(row).getByTestId('position-side').textContent).toBe('LONG');
    expect(within(row).queryByTestId('position-reduce')).toBeNull();
    expect(within(row).queryByTestId('position-close')).toBeNull();
    expect(within(row).queryByTestId('position-adjust-lev')).toBeNull();
    expect(screen.queryByTestId('safe-exit-all')).toBeNull();
    expect(screen.queryByTestId('new-position-button')).toBeNull();
  });

  it('an admin (default) still sees the order controls', () => {
    render(panel());
    expect(screen.getByTestId('position-reduce')).toBeTruthy();
    expect(screen.getByTestId('safe-exit-all')).toBeTruthy();
    expect(screen.getByTestId('new-position-button')).toBeTruthy();
  });
});
