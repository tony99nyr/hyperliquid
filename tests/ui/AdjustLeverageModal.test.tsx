/**
 * AdjustLeverageModal — verifies the margin-aware display: the REAL current liq
 * (reflecting posted margin) and the over-margined warning that adjusting leverage
 * may release that margin. The pure plan math is covered separately.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import AdjustLeverageModal, { type AdjustLeverageTarget } from '@/app/cockpit/components/AdjustLeverageModal';

function target(over: Partial<AdjustLeverageTarget> = {}): AdjustLeverageTarget {
  return { coin: 'ETH', side: 'short', entryPx: 1571.94, markPx: 1576.05, currentLeverage: 5, ...over };
}

describe('AdjustLeverageModal margin-aware display', () => {
  it('shows the REAL current liquidation (not the leverage-setting formula) + the over-margined warning', () => {
    render(<AdjustLeverageModal target={target({ realLiqPx: 2658.36, effLeverage: 1.4 })} onClose={() => {}} />);
    // Real liq 2658 shown (current-liq row + warning) — NOT the ~1880 a bare 5x formula gives.
    expect(screen.getAllByText(/2,658/).length).toBeGreaterThan(0);
    // Over-margined warning present (adjusting leverage may release posted margin).
    expect(screen.getByTestId('adjust-lev-overmargined')).toBeTruthy();
    // At no change the New-liq row reads coherently as the REAL liq (not the formula
    // ~1880) — both current and new show 2,658, so "5× → 5×" doesn't fake a liq jump.
    expect(screen.getByTestId('adjust-lev-newliq').textContent).toMatch(/2,658/);
    expect(screen.queryByText(/1,880/)).toBeNull();
  });

  it('no over-margined warning when effective leverage ≈ the setting', () => {
    render(<AdjustLeverageModal target={target({ realLiqPx: 1880, effLeverage: 4.9 })} onClose={() => {}} />);
    expect(screen.queryByTestId('adjust-lev-overmargined')).toBeNull();
  });
});
