/**
 * SafeExitButton render tests (fixtures via planOverride):
 *  - hidden with no session;
 *  - fresh plan → ok-tone status; stale/absent → danger-tone "Claude offline";
 *  - requires the one confirm step before it POSTs /api/cockpit/safe-exit;
 *  - surfaces executed / usedFallback from the response.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SafeExitButton from '@/app/cockpit/components/SafeExitButton';
import type { SafeExitPlan } from '@/types/cockpit';

const plan: SafeExitPlan = {
  id: 'p1',
  sessionId: 's1',
  intent: { clientIntentId: 'i', sessionId: 's1', coin: 'ETH', side: 'sell', sz: 2, reduceOnly: true, createdAt: 0 },
  reasoning: null,
  isFallback: false,
  updatedAt: 0,
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, executed: true, usedFallback: true }) })),
  );
});

describe('SafeExitButton', () => {
  it('renders nothing without a session', () => {
    render(<SafeExitButton sessionId={null} planOverride={{ plan: null, fresh: false, ageMs: null }} />);
    expect(screen.queryByTestId('safe-exit')).toBeNull();
  });

  it('fresh plan → ok-tone status', () => {
    render(<SafeExitButton sessionId="s1" planOverride={{ plan, fresh: true, ageMs: 10_000 }} />);
    expect(screen.getByTestId('safe-exit-status').getAttribute('data-tone')).toBe('ok');
  });

  it('stale / no plan → danger-tone "Claude offline" warning', () => {
    render(<SafeExitButton sessionId="s1" planOverride={{ plan: null, fresh: false, ageMs: null }} />);
    const status = screen.getByTestId('safe-exit-status');
    expect(status.getAttribute('data-tone')).toBe('danger');
    expect(status.textContent).toMatch(/offline|stale/i);
  });

  it('requires the confirm step before firing, then POSTs /api/cockpit/safe-exit', async () => {
    render(<SafeExitButton sessionId="s1" planOverride={{ plan, fresh: true, ageMs: 1_000 }} />);
    // First click only arms the confirm step — no fetch yet.
    fireEvent.click(screen.getByTestId('safe-exit-arm'));
    expect(fetch).not.toHaveBeenCalled();
    // The confirm button fires it.
    fireEvent.click(screen.getByTestId('safe-exit-confirm'));
    expect(fetch).toHaveBeenCalledWith('/api/cockpit/safe-exit', expect.objectContaining({ method: 'POST' }));
    await waitFor(() => expect(screen.getByTestId('safe-exit-result')).toBeTruthy());
    expect(screen.getByTestId('safe-exit-result').textContent).toMatch(/fallback/i);
  });
});
