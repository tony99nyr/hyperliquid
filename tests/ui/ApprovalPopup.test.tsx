/**
 * ApprovalPopup render tests (fixtures via actionOverride):
 *  - renders the proposal + a PAPER/LIVE badge;
 *  - PAPER: Approve is enabled immediately (one-tap);
 *  - LIVE: Approve is DISABLED until the exact "side sz coin" phrase is typed
 *    (the stronger-confirm invariant);
 *  - clicking Approve/Reject POSTs the right route with the action id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ApprovalPopup from '@/app/cockpit/components/ApprovalPopup';
import type { PendingAction } from '@/types/cockpit';

function action(mode: 'paper' | 'live'): PendingAction {
  return {
    id: 'pa1',
    sessionId: 's1',
    kind: 'entry',
    mode,
    proposal: {
      intent: { clientIntentId: 'i', sessionId: 's1', coin: 'ETH', side: 'sell', sz: 1.5, reduceOnly: true, createdAt: 0 },
      display: { coin: 'ETH', side: 'sell', sz: 1.5, estPx: 2000, stopPx: 1900, rationale: 'Take the exit.' },
    },
    status: 'pending',
    createdAt: 0,
    decidedAt: null,
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
});

describe('ApprovalPopup', () => {
  it('renders nothing when there is no pending action', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={null} />);
    expect(screen.queryByTestId('approval-popup')).toBeNull();
  });

  it('renders the proposal summary, rationale, and a PAPER badge', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={action('paper')} />);
    expect(screen.getByTestId('proposal-summary').textContent).toContain('SELL 1.5 ETH');
    expect(screen.getByText('Take the exit.')).toBeTruthy();
    expect(screen.getByTestId('mode-badge').textContent).toBe('PAPER');
  });

  it('PAPER: Approve is enabled with no extra input (one-tap)', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={action('paper')} />);
    const approve = screen.getByTestId('approve-button') as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    expect(screen.queryByTestId('live-confirm-input')).toBeNull();
  });

  it('LIVE: Approve DISABLED until the exact phrase is typed (stronger confirm)', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={action('live')} />);
    expect(screen.getByTestId('mode-badge').textContent).toBe('LIVE');
    const approve = screen.getByTestId('approve-button') as HTMLButtonElement;
    const input = screen.getByTestId('live-confirm-input') as HTMLInputElement;
    expect(approve.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'yes' } });
    expect(approve.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'sell 1.5 eth' } });
    expect(approve.disabled).toBe(false);
  });

  it('Approve POSTs /api/cockpit/approve with the action id', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={action('paper')} />);
    fireEvent.click(screen.getByTestId('approve-button'));
    expect(fetch).toHaveBeenCalledWith('/api/cockpit/approve', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.id).toBe('pa1');
  });

  it('Reject POSTs /api/cockpit/reject', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={action('paper')} />);
    fireEvent.click(screen.getByTestId('reject-button'));
    expect(fetch).toHaveBeenCalledWith('/api/cockpit/reject', expect.objectContaining({ method: 'POST' }));
  });
});
