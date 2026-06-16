/**
 * Locks the paper-vs-live mode indicator — the single most safety-relevant UI
 * element. A live session MUST render the danger-colored "LIVE TRADING" badge
 * with a non-color cue (●/glyph + text), and the read-only/decision-support
 * banner must always be present. A silent regression here is dangerous.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Banners from '@/app/cockpit/components/Banners';
import { ZONE_COLORS } from '@/app/cockpit/components/panel-styles';

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

describe('Banners (mode indicator)', () => {
  it('paper mode: muted "PAPER MODE" badge with the ○ glyph', () => {
    render(<Banners mode="paper" />);
    const badge = screen.getByTestId('banner-mode');
    expect(badge.getAttribute('data-mode')).toBe('paper');
    expect(badge.textContent).toContain('PAPER MODE');
    expect(badge.textContent).toContain('○');
    expect(badge.style.color).toBe(rgb(ZONE_COLORS.ok));
  });

  it('live mode: danger-colored "LIVE TRADING" badge with the ● glyph', () => {
    render(<Banners mode="live" />);
    const badge = screen.getByTestId('banner-mode');
    expect(badge.getAttribute('data-mode')).toBe('live');
    expect(badge.textContent).toContain('LIVE TRADING');
    expect(badge.textContent).toContain('●'); // non-color cue too
    expect(badge.style.color).toBe(rgb(ZONE_COLORS.danger));
  });

  it('always shows the decision-support (read-only) banner', () => {
    render(<Banners mode="paper" />);
    expect(screen.getByTestId('banner-readonly').textContent).toMatch(/Claude advises/i);
  });
});
