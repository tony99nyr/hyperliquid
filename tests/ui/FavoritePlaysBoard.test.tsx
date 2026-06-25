/**
 * FavoritePlaysBoard render tests — NEW + PROFITABLE sections, anti-chase extension
 * gating, empty/cold-start states. The composing hook is mocked (controlled state).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FavoritePlaysBoard from '@/app/cockpit/components/opportunity/FavoritePlaysBoard';
import type { UseFavoritePlaysState } from '@/hooks/useFavoritePlays';
import type { FavoritePlay } from '@/lib/cockpit/favorite-plays-business-logic';

const NOW = 1_700_000_000_000;
let state: UseFavoritePlaysState;
vi.mock('@/hooks/useFavoritePlays', () => ({ useFavoritePlays: () => state }));

function play(over: Partial<FavoritePlay>): FavoritePlay {
  return { id: 'x', leaderAddress: '0xfav1234567890', coin: 'ETH', side: 'long', kind: 'new', entryPx: 1000, markPx: null, extendedPct: null, unrealizedPnl: null, detectedAtMs: NOW - 60_000, ...over };
}

beforeEach(() => {
  state = { newPlays: [], profitablePlays: [], nowMs: NOW, loading: false, noFavorites: false };
});

describe('FavoritePlaysBoard', () => {
  it('cold start: prompts to favorite traders', () => {
    state.noFavorites = true;
    render(<FavoritePlaysBoard />);
    expect(screen.getByTestId('favorite-plays-empty')).toBeTruthy();
  });

  it('no plays: shows the none state', () => {
    render(<FavoritePlaysBoard />);
    expect(screen.getByTestId('favorite-plays-none')).toBeTruthy();
  });

  it('renders NEW + PROFITABLE plays', () => {
    state.newPlays = [play({ id: 'n1', kind: 'new' })];
    state.profitablePlays = [play({ id: 'p1', kind: 'profitable', markPx: 1050, extendedPct: 5, unrealizedPnl: 50 })];
    render(<FavoritePlaysBoard />);
    expect(screen.getAllByTestId('favorite-play')).toHaveLength(2);
  });

  it('hides over-extended profitable plays by default + reveals via toggle', () => {
    state.profitablePlays = [
      play({ id: 'ok', kind: 'profitable', extendedPct: 3, unrealizedPnl: 10 }),
      play({ id: 'extended', kind: 'profitable', extendedPct: 20, unrealizedPnl: 100 }),
    ];
    render(<FavoritePlaysBoard />);
    expect(screen.getAllByTestId('favorite-play')).toHaveLength(1); // extended hidden
    fireEvent.click(screen.getByTestId('favorite-plays-toggle-extended'));
    expect(screen.getAllByTestId('favorite-play')).toHaveLength(2); // now shown
  });
});
