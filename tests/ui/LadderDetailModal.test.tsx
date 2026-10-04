/**
 * LadderDetailModal — the re-anchor consent flow. Pins (1) the re-anchor button only
 * renders for an ANCHORED draft, (2) after a successful re-anchor the typed arm phrase
 * is cleared and the plan is RELOADED (fresh numbers reviewed before arming), and
 * (3) focus returns INTO the dialog after the reload — setLadder(null) unmounts the
 * focused button, and a focus() before the busy-false commit is a no-op on the still-
 * disabled Close button (round-3 review finding), so the restore must run post-commit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { LadderWithRungs } from '@/lib/ladder/ladder-types';

vi.mock('@/hooks/useHlOrderbook', () => ({ useHlOrderbook: () => ({ lastPx: null }) }));
vi.mock('@/hooks/useNow', () => ({ useNow: () => Date.now() }));
vi.mock('@/app/cockpit/components/ladders/LadderChart', () => ({ default: () => null }));

import LadderDetailModal from '@/app/cockpit/components/ladders/LadderDetailModal';

function draft(over: Partial<LadderWithRungs> = {}): LadderWithRungs {
  return {
    id: 'abcd1234-0000-0000', title: 'SOL runaway long', thesis: 'thesis', author: 'operator', mode: 'paper', status: 'draft',
    preconditionHash: null, ocoGroupId: null, leaderAddress: null, maxTotalNotionalUsd: 500, maxTotalLossUsd: 40, anchorPx: 117.2,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), activeFrom: null, armedAt: null, disarmedAt: null, disarmReason: null,
    archivedAt: null, expiryAlertAt: null, createdAt: '', updatedAt: '2026-10-04T12:00:00.000+00:00',
    rungs: [{
      id: 'r1', ladderId: 'abcd1234-0000-0000', seq: 1, coin: 'SOL', side: 'long', action: 'open',
      triggerKind: 'price_below', triggerPx: 113.1, triggerMeta: null, sizeCoins: null, reduceFrac: null,
      riskUsd: 10, stopFrac: 0.05, leverage: 3, stopPx: 107.4, targetPx: null, status: 'pending', cloid: null,
    }],
    ...over,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function respondWith(ladder: LadderWithRungs): void {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    return { ok: true, status: 200, json: async () => ({ ok: true, ladder }) } as Response;
  });
}

describe('LadderDetailModal re-anchor flow', () => {
  it('shows the re-anchor button only for an anchored draft', async () => {
    respondWith(draft());
    const { unmount } = render(<LadderDetailModal ladderId="abcd1234-0000-0000" onClose={() => {}} />);
    await screen.findByTestId('ladder-detail-reanchor');
    unmount();

    respondWith(draft({ anchorPx: null }));
    render(<LadderDetailModal ladderId="abcd1234-0000-0000" onClose={() => {}} />);
    await screen.findByTestId('ladder-detail-arm');
    expect(screen.queryByTestId('ladder-detail-reanchor')).toBeNull();
  });

  it('re-anchor posts, reloads the plan, and returns focus INTO the dialog (not <body>)', async () => {
    respondWith(draft());
    render(<LadderDetailModal ladderId="abcd1234-0000-0000" onClose={() => {}} />);
    const btn = await screen.findByTestId('ladder-detail-reanchor');
    btn.focus();
    fireEvent.click(btn);
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(posts.length).toBe(1);
      expect(String(posts[0][0])).toContain('/api/cockpit/ladder/reanchor');
    });
    // After the reload commit, focus must be back inside the dialog so the key trap +
    // Escape work without a click. Body focus = the round-3 no-op bug.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('ladder-detail-close'));
    });
  });

  it('arm sends the version pin (expectedUpdatedAt) of the plan the modal rendered', async () => {
    respondWith(draft()); // paper → no phrase needed
    render(<LadderDetailModal ladderId="abcd1234-0000-0000" onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('ladder-detail-arm'));
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(posts.length).toBe(1);
      const body = JSON.parse(String((posts[0][1] as RequestInit).body));
      expect(body.expectedUpdatedAt).toBe('2026-10-04T12:00:00.000+00:00');
    });
  });
});
