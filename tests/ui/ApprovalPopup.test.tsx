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

  it('a11y: PAPER moves initial focus to the Reject button', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={action('paper')} />);
    expect(document.activeElement).toBe(screen.getByTestId('reject-button'));
  });

  it('a11y: LIVE moves initial focus to the typed-confirm input', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={action('live')} />);
    expect(document.activeElement).toBe(screen.getByTestId('live-confirm-input'));
  });

  it('a11y: Esc rejects (POSTs /api/cockpit/reject)', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={action('paper')} />);
    fireEvent.keyDown(screen.getByTestId('approval-popup'), { key: 'Escape' });
    expect(fetch).toHaveBeenCalledWith('/api/cockpit/reject', expect.objectContaining({ method: 'POST' }));
  });

  it('a11y: keeps role=dialog + aria-modal', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={action('paper')} />);
    const dialog = screen.getByTestId('approval-popup');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('reduce-only exit: shows NO leverage control', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={action('paper')} />);
    expect(screen.queryByTestId('leverage-control')).toBeNull();
  });
});

/** An OPENING entry (not reduce-only) with a stop — drives the leverage control. */
function openingAction(over: { leverage?: number; coinMax?: number; stopPx?: number; estPx?: number } = {}): PendingAction {
  return {
    id: 'pa-open',
    sessionId: 's1',
    kind: 'entry',
    mode: 'paper',
    proposal: {
      intent: { clientIntentId: 'i', sessionId: 's1', coin: 'ETH', side: 'buy', sz: 1, reduceOnly: false, leverage: over.leverage ?? 5, createdAt: 0 },
      display: {
        coin: 'ETH', side: 'buy', sz: 1,
        estPx: over.estPx ?? 2000,
        stopPx: over.stopPx ?? 1900,
        rationale: 'Long the breakout.',
        leverage: over.leverage ?? 5,
        coinMaxLeverage: over.coinMax ?? 20,
        leaderLeverage: 20,
        leaderAddress: '0xabcdef0000000000000000000000000000001234',
      },
    },
    status: 'pending',
    createdAt: 0,
    decidedAt: null,
  };
}

describe('ApprovalPopup — leverage control (Item 3)', () => {
  it('OPENING order: renders the slider seeded to the proposal leverage + the live read', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={openingAction({ leverage: 5 })} />);
    const slider = screen.getByTestId('leverage-slider') as HTMLInputElement;
    expect(slider.value).toBe('5');
    expect(slider.max).toBe('20');
    // Live read: margin = notional/lev = 2000/5 = 400; liq = entry*(1-1/5)=1600.
    expect(screen.getByTestId('leverage-margin').textContent).toContain('400');
    expect(screen.getByTestId('leverage-liq').textContent).toContain('1,600');
    // ROE @ stop: -5% * 5 = -25%.
    expect(screen.getByTestId('leverage-roe-stop').textContent).toContain('25');
  });

  it('moving the slider updates margin/liq/ROE live (notional unchanged)', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={openingAction({ leverage: 5 })} />);
    const slider = screen.getByTestId('leverage-slider');
    fireEvent.change(slider, { target: { value: '10' } });
    // margin = 2000/10 = 200; liq = 2000*(1-1/10)=1800.
    expect(screen.getByTestId('leverage-margin').textContent).toContain('200');
    expect(screen.getByTestId('leverage-liq').textContent).toContain('1,800');
  });

  it('Match-leader sets the slider to the leader leverage; ½ leader halves it', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={openingAction({ leverage: 5, coinMax: 25 })} />);
    fireEvent.click(screen.getByTestId('match-leader-button'));
    expect((screen.getByTestId('leverage-slider') as HTMLInputElement).value).toBe('20'); // leader = 20×
    fireEvent.click(screen.getByTestId('half-leader-button'));
    expect((screen.getByTestId('leverage-slider') as HTMLInputElement).value).toBe('10'); // ½ of 20
  });

  it('SAFETY GUARD: warns when liquidation falls inside the stop (5% stop @ 20x)', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={openingAction({ leverage: 5, coinMax: 20, stopPx: 1900 })} />);
    // 5x is safe (liq 1600 < stop 1900) → no warning.
    expect(screen.queryByTestId('liq-inside-stop-warning')).toBeNull();
    // Crank to 20x → liq ≈ 1900 = stop → warning fires.
    fireEvent.change(screen.getByTestId('leverage-slider'), { target: { value: '20' } });
    expect(screen.getByTestId('liq-inside-stop-warning')).toBeTruthy();
  });

  it('Approve sends the CHOSEN leverage to /api/cockpit/approve', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={openingAction({ leverage: 5 })} />);
    fireEvent.change(screen.getByTestId('leverage-slider'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('approve-button'));
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.id).toBe('pa-open');
    expect(body.leverage).toBe(8);
  });

  it('shows the followed leader (short addr)', () => {
    render(<ApprovalPopup sessionId={null} actionOverride={openingAction()} />);
    expect(screen.getByTestId('approval-leader').textContent).toContain('0xabcd');
  });
});
