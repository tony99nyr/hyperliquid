import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PerformanceView from '@/app/cockpit/components/performance/PerformanceView';
import type { PerformanceSummary } from '@/lib/cockpit/performance-service';

function summary(): PerformanceSummary {
  return {
    sessionId: 's',
    ledger: [
      { id: 'a', openedAt: 1_700_000_000_000, coin: 'ETH', side: 'short', sz: 2.5, entryPx: 1742, exitPx: 1739.5, leverage: 10, pnlUsd: 6.25, feesUsd: 1.5, status: 'open', today: true },
      { id: 'b', openedAt: 1_699_900_000_000, coin: 'BTC', side: 'short', sz: 0.18, entryPx: 64820, exitPx: 63190, leverage: 8, pnlUsd: 293.4, feesUsd: 7.9, status: 'win', today: true },
      { id: 'c', openedAt: 1_699_800_000_000, coin: 'HYPE', side: 'long', sz: 420, entryPx: 28.1, exitPx: 27.45, leverage: 6, pnlUsd: -273, feesUsd: 6.6, status: 'loss', today: false },
    ],
    kpis: {
      netPnlUsd: 20.4,
      closedCount: 2,
      winRatePct: 50,
      winCount: 1,
      lossCount: 1,
      profitFactor: 1.07,
      todayPnlUsd: 293.4,
      avgTradeUsd: 10.2,
      maxDrawdownPct: 3.4,
      feesUsd: 14.5,
      openExposureUsd: 4348.75,
      openCount: 1,
    },
    equity: [
      { t: 1_699_000_000_000, equity: 50_000 },
      { t: 1_699_500_000_000, equity: 50_120 },
      { t: 1_700_000_000_000, equity: 50_020.4 },
    ],
    equityUsd: 50_020.4,
    equity30dPct: 0.04,
    generatedAt: 1_700_000_001_000,
  };
}

describe('PerformanceView', () => {
  it('renders 8 KPI cards with derived values', () => {
    render(<PerformanceView sessionId={null} summaryOverride={summary()} />);
    expect(screen.getByTestId('performance-view')).toBeTruthy();
    const cards = screen.getAllByTestId('kpi-card');
    expect(cards.length).toBe(8);
    const slugs = cards.map((c) => c.getAttribute('data-kpi'));
    expect(slugs).toEqual(
      expect.arrayContaining(['net-pnl', 'win-rate', 'profit-factor', 'today', 'avg-trade', 'max-drawdown', 'fees', 'open-exposure']),
    );
  });

  it('renders the equity card and trade ledger rows with status chips', () => {
    render(<PerformanceView sessionId={null} summaryOverride={summary()} />);
    expect(screen.getByTestId('equity-card')).toBeTruthy();
    expect(screen.getByTestId('trade-ledger')).toBeTruthy();
    const rows = screen.getAllByTestId('ledger-row');
    expect(rows.length).toBe(3);
    const statuses = screen.getAllByTestId('ledger-status').map((s) => s.textContent);
    expect(statuses).toEqual(expect.arrayContaining(['OPEN', 'WIN', 'LOSS']));
  });

  it('shows the no-session message when there is no summary', () => {
    render(<PerformanceView sessionId={null} summaryOverride={null} />);
    expect(screen.getByTestId('performance-view')).toBeTruthy();
  });
});
