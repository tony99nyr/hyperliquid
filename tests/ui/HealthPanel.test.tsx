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
  return { id: 'h', sessionId: 's', createdAt: 0, score, pContinuation: 0.55, pAdverse: 0.3, alerts };
}

describe('HealthPanel', () => {
  it('renders the score and probabilities', () => {
    render(<HealthPanel sessionId={null} snapshotOverride={snap(72)} />);
    expect(screen.getByText('72')).toBeTruthy();
    expect(screen.getByTestId('p-continuation').textContent).toBe('55%');
    expect(screen.getByTestId('p-adverse').textContent).toBe('30%');
  });

  it('gauge is in the OK zone for a healthy score', () => {
    render(<HealthPanel sessionId={null} snapshotOverride={snap(80)} />);
    const gauge = screen.getByRole('img');
    expect(gauge.getAttribute('data-zone')).toBe('ok');
  });

  it('gauge enters the warn zone at the 35–60 threshold band', () => {
    render(<HealthPanel sessionId={null} snapshotOverride={snap(45)} />);
    expect(screen.getByRole('img').getAttribute('data-zone')).toBe('warn');
  });

  it('gauge enters the critical (danger) zone below 35', () => {
    render(<HealthPanel sessionId={null} snapshotOverride={snap(20)} />);
    expect(screen.getByRole('img').getAttribute('data-zone')).toBe('critical');
  });

  it('renders fired alerts with the danger border styling', () => {
    render(<HealthPanel sessionId={null} snapshotOverride={snap(40, ['bearish-divergence-1h', 'stop-within-1-ATR'])} />);
    const list = screen.getByTestId('health-alerts');
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute('data-alert')).toBe('bearish-divergence-1h');
    expect(items[0].style.borderLeft).toContain(rgb(ZONE_COLORS.danger));
    expect(items[0].textContent).toBe('Bearish divergence 1H');
  });

  it('shows a no-alerts state when none fire', () => {
    render(<HealthPanel sessionId={null} snapshotOverride={snap(80, [])} />);
    expect(screen.getByTestId('health-no-alerts').textContent).toBe('No alerts firing.');
  });

  it('shows an awaiting state with a null snapshot', () => {
    render(<HealthPanel sessionId={null} snapshotOverride={null} />);
    expect(screen.getByText('awaiting assessment…')).toBeTruthy();
  });
});
