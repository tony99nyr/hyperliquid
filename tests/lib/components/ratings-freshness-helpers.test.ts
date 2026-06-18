import { describe, it, expect } from 'vitest';
import {
  formatRatingsDate,
  isRatingsStale,
  RATINGS_STALE_DAYS,
} from '@/app/cockpit/components/left-rail/ratings-freshness-helpers';

describe('formatRatingsDate', () => {
  it('formats an ISO timestamp to a stable absolute date (UTC, no locale)', () => {
    expect(formatRatingsDate('2026-06-15T03:33:00.000Z')).toBe('Jun 15 2026');
    expect(formatRatingsDate('2026-01-02T23:59:59Z')).toBe('Jan 2 2026');
    expect(formatRatingsDate('2025-12-31')).toBe('Dec 31 2025');
  });

  it('returns "unknown" for null / missing / unparseable input', () => {
    expect(formatRatingsDate(null)).toBe('unknown');
    expect(formatRatingsDate(undefined)).toBe('unknown');
    expect(formatRatingsDate('')).toBe('unknown');
    expect(formatRatingsDate('not-a-date')).toBe('unknown');
    expect(formatRatingsDate('2026-13-40T00:00:00Z')).toBe('unknown'); // out-of-range
  });
});

describe('isRatingsStale', () => {
  const gen = '2026-06-15T00:00:00.000Z';
  const genMs = Date.parse(gen);

  it('is fresh within the cadence window', () => {
    expect(isRatingsStale(gen, genMs + 3 * 86_400_000)).toBe(false); // 3 days later
    expect(isRatingsStale(gen, genMs + (RATINGS_STALE_DAYS - 1) * 86_400_000)).toBe(false);
  });

  it('is stale once past maxDays', () => {
    expect(isRatingsStale(gen, genMs + (RATINGS_STALE_DAYS + 1) * 86_400_000)).toBe(true);
  });

  it('treats null / unparseable as stale (cannot prove freshness)', () => {
    expect(isRatingsStale(null, genMs)).toBe(true);
    expect(isRatingsStale('garbage', genMs)).toBe(true);
  });

  it('respects a custom maxDays', () => {
    expect(isRatingsStale(gen, genMs + 2 * 86_400_000, 1)).toBe(true);
    expect(isRatingsStale(gen, genMs + 2 * 86_400_000, 5)).toBe(false);
  });
});
