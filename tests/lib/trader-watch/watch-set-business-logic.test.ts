import { describe, it, expect } from 'vitest';
import { resolveWatchSet, normalizeLeaderAddress } from '@/lib/trader-watch/watch-set-business-logic';

const A = '0xAAa0000000000000000000000000000000000001';
const B = '0xBbB0000000000000000000000000000000000002';
const C = '0xccc0000000000000000000000000000000000003';

describe('resolveWatchSet', () => {
  it('unions favorites and follow-leaders, normalized + deduped + sorted', () => {
    const set = resolveWatchSet({ favorites: [A, B], followLeaders: [B, C] });
    expect(set).toEqual([A, B, C].map(normalizeLeaderAddress)); // sorted, lowercased
    expect(new Set(set).size).toBe(3); // B deduped across both inputs
  });

  it('dedupes the SAME address differing only by case', () => {
    expect(resolveWatchSet({ favorites: [A, A.toLowerCase()], followLeaders: [] })).toHaveLength(1);
  });

  it('returns empty for no favorites and no follows (watch nothing)', () => {
    expect(resolveWatchSet({ favorites: [], followLeaders: [] })).toEqual([]);
  });

  it('drops blank/whitespace entries', () => {
    expect(resolveWatchSet({ favorites: ['', '   ', A], followLeaders: [] })).toEqual([normalizeLeaderAddress(A)]);
  });

  it('includes a follow-leader even when not separately favorited', () => {
    expect(resolveWatchSet({ favorites: [A], followLeaders: [C] })).toContain(normalizeLeaderAddress(C));
  });
});
