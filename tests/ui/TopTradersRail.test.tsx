/**
 * TopTradersRail render tests — ranked rated-trader rows + the deferred action
 * feed slot. Fixtures via the `traders` prop (pre-sliced server-side).
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TopTradersRail from '@/app/cockpit/components/left-rail/TopTradersRail';
import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';

const traders: TopTraderRow[] = [
  { address: '0xaaa', short: '0xaa…aaa', displayName: 'Ace', composite: 9, hasRisk: false, flags: ['CLEAN_BOOK'], leaderboardTop: true, topCoins: ['ETH', 'BTC'] },
  { address: '0xbbb', short: '0xbb…bbb', displayName: null, composite: 3, hasRisk: true, flags: ['DEEP_MARTINGALE'], leaderboardTop: false, topCoins: ['SOL'] },
];

describe('TopTradersRail', () => {
  it('renders ranked trader rows with composite scores', () => {
    render(<TopTradersRail traders={traders} />);
    const rows = screen.getAllByTestId('top-trader-row');
    expect(rows).toHaveLength(2);
    const scores = screen.getAllByTestId('trader-composite').map((e) => e.textContent);
    expect(scores).toEqual(['9', '3']);
    expect(screen.getByText('Ace')).toBeTruthy();
  });

  it('flags a risky wallet with a RISK chip', () => {
    render(<TopTradersRail traders={traders} />);
    expect(screen.getAllByTestId('trader-risk')).toHaveLength(1);
  });

  it('highlights the followed wallet', () => {
    render(<TopTradersRail traders={traders} followedAddress="0xBBB" />);
    const rows = screen.getAllByTestId('top-trader-row');
    expect(rows[1].getAttribute('data-followed')).toBe('true');
    expect(rows[0].getAttribute('data-followed')).toBe('false');
  });

  it('shows the deferred action-feed slot', () => {
    render(<TopTradersRail traders={traders} />);
    expect(screen.getByTestId('trader-feed-slot').textContent).toMatch(/coming soon/i);
  });

  it('shows an empty state with no traders', () => {
    render(<TopTradersRail traders={[]} />);
    expect(screen.getByText(/No rated wallets/i)).toBeTruthy();
  });
});
