import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ScoutPanel from '@/app/cockpit/components/ScoutPanel';
import type { PnlSnapshot, PositionRow } from '@/hooks/realtime-row-mappers';
import type { PerformanceSummary } from '@/lib/cockpit/performance-service';

function perf(over: Partial<PerformanceSummary['kpis']> = {}): PerformanceSummary {
  return {
    sessionId: '',
    ledger: [],
    kpis: {
      netPnlUsd: 39.73, closedCount: 12, winRatePct: 50, winCount: 6, lossCount: 6,
      profitFactor: 1.4, todayPnlUsd: 0, avgTradeUsd: 3.31, maxDrawdownPct: 8, feesUsd: 1.2,
      openExposureUsd: 0, openCount: 0, ...over,
    },
    equity: [
      { t: 1, equity: 0 }, { t: 2, equity: 12 }, { t: 3, equity: 39.73 },
    ],
    equityUsd: null,
    netPnlUsd: 39.73,
    equity30dPct: null,
    generatedAt: 0,
  };
}

function position(over: Partial<PositionRow> = {}): PositionRow {
  return {
    id: over.coin ?? 'ETH',
    sessionId: 's',
    coin: 'ETH',
    side: 'short',
    sz: 2.5,
    avgEntryPx: 1742,
    realizedPnlUsd: 0,
    feesPaidUsd: 0,
    leverage: 5,
    updatedAt: 0,
    ...over,
  };
}

function pnl(coin: string, markPx: number, uPnl: number): PnlSnapshot {
  return { id: coin, sessionId: 's', coin, realizedPnlUsd: 0, unrealizedPnlUsd: uPnl, feesPaidUsd: 0, markPx, createdAt: 0 };
}

describe('ScoutPanel — open positions', () => {
  it('shows "flat" when the scout holds nothing', () => {
    render(<ScoutPanel hypsOverride={[]} positionsOverride={{ positions: [], latestPnlByCoin: {} }} />);
    expect(screen.getByTestId('scout-pos-count').textContent).toContain('0');
    expect(screen.getByTestId('scout-pos-flat')).toBeTruthy();
  });

  it('renders a scout open position with side, size·lev, entry and uPnL', () => {
    render(
      <ScoutPanel
        hypsOverride={[]}
        positionsOverride={{
          positions: [position({ coin: 'ETH', side: 'short', sz: 2.5, avgEntryPx: 1742, leverage: 5 })],
          latestPnlByCoin: { ETH: pnl('ETH', 1730, 30) },
        }}
      />,
    );
    expect(screen.getByTestId('scout-pos-count').textContent).toContain('1');
    const row = screen.getByTestId('scout-position-row');
    expect(within(row).getByTestId('scout-pos-side').textContent).toBe('SHORT');
    expect(row.textContent).toContain('5×');
    // short from 1742 → mark 1730 is a gain
    expect(within(row).getByTestId('scout-pos-upnl').textContent).toContain('+');
  });

  it('sums uPnL across multiple open positions into the header total', () => {
    render(
      <ScoutPanel
        hypsOverride={[]}
        positionsOverride={{
          positions: [position({ coin: 'ETH' }), position({ coin: 'SOL', side: 'long', sz: 50, avgEntryPx: 70 })],
          latestPnlByCoin: { ETH: pnl('ETH', 1730, 30), SOL: pnl('SOL', 72, 100) },
        }}
      />,
    );
    expect(screen.getByTestId('scout-pos-count').textContent).toContain('2');
    // 30 + 100 = +$130 total
    expect(screen.getByTestId('scout-pos-total').textContent).toContain('130');
  });

  it('still renders the theses feed alongside positions', () => {
    render(
      <ScoutPanel
        hypsOverride={[]}
        positionsOverride={{ positions: [position()], latestPnlByCoin: { ETH: pnl('ETH', 1730, 30) } }}
      />,
    );
    expect(screen.getByTestId('scout-positions')).toBeTruthy();
    expect(screen.getByTestId('scout-empty')).toBeTruthy(); // no theses → empty feed line
  });
});

describe('ScoutPanel — track record', () => {
  it('shows real net P&L, trade count and win rate from the perf fold', () => {
    render(<ScoutPanel hypsOverride={[]} positionsOverride={{ positions: [], latestPnlByCoin: {} }} perfOverride={perf()} />);
    const tr = screen.getByTestId('scout-track-record');
    expect(screen.getByTestId('scout-net-pnl').textContent).toContain('39.73');
    expect(tr.textContent).toContain('12'); // trades
    expect(tr.textContent).toContain('6W');
    expect(tr.textContent).toContain('50%'); // win rate
    expect(screen.getByTestId('scout-sparkline')).toBeTruthy();
  });

  it('shows "—" net P&L when the scout has no track record yet', () => {
    render(<ScoutPanel hypsOverride={[]} positionsOverride={{ positions: [], latestPnlByCoin: {} }} perfOverride={null} />);
    expect(screen.getByTestId('scout-net-pnl').textContent).toBe('—');
    expect(screen.queryByTestId('scout-sparkline')).toBeNull();
  });
});
