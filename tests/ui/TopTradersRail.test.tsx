/**
 * TopTradersRail render tests — ranked rated-trader rows + the deferred action
 * feed slot. Fixtures via the `traders` prop (pre-sliced server-side).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TopTradersRail from '@/app/cockpit/components/left-rail/TopTradersRail';
import type { TopTraderRow } from '@/lib/hyperliquid/top-traders-service';

// The drawer fetches live positions on open; stub fetch so it never hits network.
vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: true,
  json: async () => ({ ok: true, state: { positions: [], accountValueUsd: 0, stale: false } }),
})) as unknown as typeof fetch);

const emptyMetrics = {
  sharpe: null, winRate: null, profitFactor: null, maxDrawdownFrac: null,
  aggregatePnlUsd: null, medianHoldHours: null, nFills: null, worstLossVsMedianWin: null,
};

const traders: TopTraderRow[] = [
  { address: '0xaaa', short: '0xaa…aaa', displayName: 'Ace', composite: 9, hasRisk: false, flags: ['CLEAN_BOOK'], allFlags: ['CLEAN_BOOK'], leaderboardTop: true, topCoins: ['ETH', 'BTC'], metrics: { ...emptyMetrics, sharpe: 3.3, winRate: 0.62 } },
  { address: '0xbbb', short: '0xbb…bbb', displayName: null, composite: 3, hasRisk: true, flags: ['DEEP_MARTINGALE'], allFlags: ['DEEP_MARTINGALE', 'LIVE_DEEP_STACK'], leaderboardTop: false, topCoins: ['SOL'], metrics: emptyMetrics },
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

  it('opens the trader-detail drawer when a row is clicked', async () => {
    render(<TopTradersRail traders={traders} />);
    expect(screen.queryByTestId('trader-detail-drawer')).toBeNull();
    fireEvent.click(screen.getAllByTestId('top-trader-row')[1]);
    // findBy* awaits React settling the on-open fetch state update (no act warning).
    const drawer = await screen.findByTestId('trader-detail-drawer');
    expect(drawer.getAttribute('role')).toBe('dialog');
    // The risky trader's flags render with meanings (the safe-to-follow read).
    expect(screen.getByTestId('trader-flags')).toBeTruthy();
    expect(screen.getByTestId('trader-detail-verdict').getAttribute('data-level')).toBe('danger');
  });

  it('closes the drawer on the close button', async () => {
    render(<TopTradersRail traders={traders} />);
    fireEvent.click(screen.getAllByTestId('top-trader-row')[0]);
    expect(await screen.findByTestId('trader-detail-drawer')).toBeTruthy();
    fireEvent.click(screen.getByTestId('trader-detail-close'));
    expect(screen.queryByTestId('trader-detail-drawer')).toBeNull();
  });
});
