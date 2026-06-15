import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ContextGauge from '@/app/cockpit/components/ContextGauge';
import { ZONE_COLORS } from '@/app/cockpit/components/panel-styles';
import type { ContextGauge as ContextGaugeRow } from '@/types/cockpit';

/** jsdom normalizes inline hex colors to rgb(); convert for comparison. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function sample(approxPct: number, zone: ContextGaugeRow['zone']): ContextGaugeRow {
  return { id: 'c', sessionId: 's', createdAt: 0, approxPct, zone };
}

describe('ContextGauge', () => {
  it('is labeled approximate', () => {
    render(<ContextGauge sessionId={null} sampleOverride={sample(20, 'ok')} />);
    expect(screen.getByText('(approx)')).toBeTruthy();
  });

  it('renders the percent and an OK zone with green styling', () => {
    render(<ContextGauge sessionId={null} sampleOverride={sample(30, 'ok')} />);
    expect(screen.getByTestId('context-pct').textContent).toBe('30%');
    const section = screen.getByTestId('context-gauge');
    expect(section.getAttribute('data-zone')).toBe('ok');
    expect(screen.getByTestId('context-bar-fill').style.background).toBe(rgb(ZONE_COLORS.ok));
    expect(screen.getByTestId('context-bar-fill').style.width).toBe('30%');
  });

  it('warning zone uses warn color + WARN label', () => {
    render(<ContextGauge sessionId={null} sampleOverride={sample(72, 'warn')} />);
    expect(screen.getByTestId('context-gauge').getAttribute('data-zone')).toBe('warn');
    expect(screen.getByTestId('context-bar-fill').style.background).toBe(rgb(ZONE_COLORS.warn));
    expect(screen.getByTestId('context-zone-label').textContent).toContain('WARN');
  });

  it('critical zone uses danger color + CRITICAL label', () => {
    render(<ContextGauge sessionId={null} sampleOverride={sample(92, 'critical')} />);
    expect(screen.getByTestId('context-gauge').getAttribute('data-zone')).toBe('critical');
    expect(screen.getByTestId('context-bar-fill').style.background).toBe(rgb(ZONE_COLORS.danger));
    expect(screen.getByTestId('context-zone-label').textContent).toContain('CRITICAL');
  });

  it('renders a placeholder with no sample', () => {
    render(<ContextGauge sessionId={null} sampleOverride={null} />);
    expect(screen.getByTestId('context-pct').textContent).toBe('—');
  });
});
