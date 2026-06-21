import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import HealthPanel from '@/app/cockpit/components/HealthPanel';
import { ZONE_COLORS } from '@/app/cockpit/components/panel-styles';
import type { HealthSnapshot } from '@/types/cockpit';

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

describe('HealthPanel — FLAT (no position) renders nothing', () => {
  it('renders nothing when flat (the Opportunity board + Market Regime panel are the entry read)', () => {
    const { container } = render(<HealthPanel sessionId={null} inPositionOverride={false} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('health-panel')).toBeNull();
  });
});
