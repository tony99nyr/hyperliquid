import { describe, expect, it } from 'vitest';
import { formatFigure, formatLoss, formatNote, formatUtcDate, groupMarkers, unitTag, verdictChip } from '@/app/cockpit/components/lanes-performance/format';
import type { Figure, MarkerInput } from '@/lib/performance/lane-performance-business-logic';

const figure = (value: number | null, unit: Figure['unit']): Figure => ({ value, unit, n: 1, source: 'test' });

describe('lane performance formatting', () => {
  it('formats the report units without hiding their meaning', () => {
    expect(formatFigure(figure(12.5, 'usd'))).toBe('+$12.50');
    expect(formatFigure(figure(-0.25, 'r_slip'))).toBe('-0.25R');
    expect(formatFigure(figure(0.625, 'probability'))).toBe('63%');
    expect(formatFigure(figure(null, 'r'))).toBe('—');
    expect(unitTag('r_nominal')).toBe('R nominal');
    expect(unitTag('r_slip')).toBe('R slip');
    expect(formatFigure(figure(12.345, 'unlisted' as Figure['unit']))).toBe('12.345');
  });

  it('maps verdicts to the intended chip colours', () => {
    expect(verdictChip('KILL').colour).toBe('#ff8793');
    expect(verdictChip('COLLECT').colour).toBe('#91adff');
    expect(verdictChip('continue').colour).toBe('#d6dce6');
  });

  it('groups confirmed and proposed markers by confirmation time', () => {
    const markers = [
      { id: 'confirmed', confirmed_at: '2026-10-24T00:00:00Z' },
      { id: 'proposed', confirmed_at: null },
    ] as MarkerInput[];
    expect(groupMarkers(markers).confirmed.map((marker) => marker.id)).toEqual(['confirmed']);
    expect(groupMarkers(markers).proposed.map((marker) => marker.id)).toEqual(['proposed']);
  });

  it('formats ISO timestamps as UTC chart ticks and marker dates', () => {
    expect(formatUtcDate('2026-10-24T23:22:50.514Z', 'tick')).toBe('24 Oct');
    expect(formatUtcDate('2026-10-24T23:22:50.514Z', 'legend')).toBe('24 Oct 2026');
  });

  it('formats a drawdown as a loss and shortens large figures', () => {
    expect(formatLoss(figure(0.1, 'usd'))).toBe('-$0.10');
    expect(formatFigure(figure(1_250_000, 'usd'))).toBe('+$1.25m');
  });

  it('formats an ISO timestamp inside a note', () => {
    expect(formatNote('Updated 2026-10-24T12:00:00Z')).toBe('Updated 24 Oct 2026, 12:00 UTC');
    expect(formatNote('Updated 2026-10-24T08:00:00-04:00')).toBe('Updated 24 Oct 2026, 12:00 UTC');
  });
});
