import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import HealthPanel from '@/app/cockpit/components/HealthPanel';
import { ZONE_COLORS } from '@/app/cockpit/components/panel-styles';
import type { HealthSnapshot } from '@/types/cockpit';
import type { RegimeStripRow } from '@/app/cockpit/components/right-rail/regime-strip-helpers';

/** jsdom normalizes inline hex colors to rgb(); convert for comparison. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function snap(score: number, alerts: string[] = []): HealthSnapshot {
  return { id: 'h', sessionId: 's', coin: 'ETH', createdAt: 0, score, pContinuation: 0.55, pAdverse: 0.3, alerts };
}

/** Render the in-position (Trade Health) view: force inPositionOverride. */
function tradeHealthProps(snapshot: HealthSnapshot | null) {
  return { sessionId: null, snapshotOverride: snapshot, inPositionOverride: true };
}

describe('HealthPanel — TRADE HEALTH (in a position)', () => {
  it('renders the score and probabilities', () => {
    render(<HealthPanel {...tradeHealthProps(snap(72))} coin="ETH" />);
    expect(screen.getByTestId('health-panel').getAttribute('data-mode')).toBe('trade-health');
    // Coin-labeled title (per-position health — the multi-position fix).
    expect(screen.getByText(/Trade Health · ETH/)).toBeTruthy();
    expect(screen.getByText('72')).toBeTruthy();
    expect(screen.getByTestId('p-continuation').textContent).toBe('55%');
    expect(screen.getByTestId('p-adverse').textContent).toBe('30%');
  });

  it('gauge is in the OK zone for a healthy score', () => {
    render(<HealthPanel {...tradeHealthProps(snap(80))} />);
    expect(screen.getByRole('img').getAttribute('data-zone')).toBe('ok');
  });

  it('gauge enters the warn zone at the 35–60 threshold band', () => {
    render(<HealthPanel {...tradeHealthProps(snap(45))} />);
    expect(screen.getByRole('img').getAttribute('data-zone')).toBe('warn');
  });

  it('gauge enters the critical (danger) zone below 35', () => {
    render(<HealthPanel {...tradeHealthProps(snap(20))} />);
    expect(screen.getByRole('img').getAttribute('data-zone')).toBe('critical');
  });

  it('renders fired alerts as color-coded chips', () => {
    render(<HealthPanel {...tradeHealthProps(snap(40, ['bearish-divergence-1h', 'stop-within-1-ATR']))} />);
    const list = screen.getByTestId('health-alerts');
    const chips = list.querySelectorAll('[data-testid="alert-chip"]');
    expect(chips).toHaveLength(2);
    const divergence = list.querySelector('[data-alert="bearish-divergence-1h"]') as HTMLElement;
    expect(divergence.textContent).toBe('Bearish divergence 1H');
    expect(divergence.style.color).toBe(rgb(ZONE_COLORS.warn));
    const stop = list.querySelector('[data-alert="stop-within-1-ATR"]') as HTMLElement;
    expect(stop.style.color).toBe(rgb(ZONE_COLORS.danger));
  });

  it('shows a no-alerts state when none fire', () => {
    render(<HealthPanel {...tradeHealthProps(snap(80, []))} />);
    expect(screen.getByTestId('health-no-alerts').textContent).toBe('No alerts firing.');
  });

  it('shows an awaiting state with a null snapshot', () => {
    render(<HealthPanel {...tradeHealthProps(null)} />);
    expect(screen.getByText('awaiting watcher assessment…')).toBeTruthy();
  });
});

const bullRows: RegimeStripRow[] = [
  { timeframe: '1d', regime: 'bullish', confidence: 0.8, rsi: 60, noData: false },
  { timeframe: '8h', regime: 'bullish', confidence: 0.7, rsi: 58, noData: false },
  { timeframe: '1h', regime: 'bullish', confidence: 0.6, rsi: 55, noData: false },
  { timeframe: '15m', regime: 'neutral', confidence: 0.3, rsi: 50, noData: false },
];

const bearRows: RegimeStripRow[] = bullRows.map((r) => ({ ...r, regime: r.regime === 'bullish' ? 'bearish' : r.regime }));

describe('HealthPanel — MARKET READ / ENTRY (flat)', () => {
  it('renders the market-read frame when flat (no position)', () => {
    render(<HealthPanel sessionId={null} inPositionOverride={false} regimeRowsOverride={bullRows} />);
    const panel = screen.getByTestId('health-panel');
    expect(panel.getAttribute('data-mode')).toBe('market-read');
    expect(screen.getByText(/Market Read \/ Entry/i)).toBeTruthy();
    // NO position-health score gauge for a non-existent position.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByTestId('p-continuation')).toBeNull();
  });

  it('derives a LONG bias from bullish higher timeframes', () => {
    render(<HealthPanel sessionId={null} inPositionOverride={false} regimeRowsOverride={bullRows} />);
    expect(screen.getByTestId('entry-bias-side').getAttribute('data-side')).toBe('long');
    expect(screen.getByTestId('entry-bias-guidance').textContent).toMatch(/buy entry/i);
  });

  it('derives a SHORT bias from bearish higher timeframes', () => {
    render(<HealthPanel sessionId={null} inPositionOverride={false} regimeRowsOverride={bearRows} />);
    expect(screen.getByTestId('entry-bias-side').getAttribute('data-side')).toBe('short');
  });

  it('shows the regime strip as numbers in the entry read', () => {
    render(<HealthPanel sessionId={null} inPositionOverride={false} regimeRowsOverride={bullRows} />);
    expect(screen.getByTestId('regime-strip')).toBeTruthy();
    expect(screen.getByTestId('regime-label-1d').textContent).toBe('BULL');
  });
});
