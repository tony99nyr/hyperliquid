/**
 * Pins requireApproval — the web/terminal approval gate dispatch.
 *
 * - No session ⇒ falls back to the terminal confirmation (so headless scripts
 *   still run), preserving LIVE exact-phrase rigor.
 * - Supabase configured + session ⇒ writes a pending row and polls; resolves
 *   TRUE only when the poll says approved, FALSE otherwise (NO-AUTO-FIRE).
 *
 * The Supabase service module is mocked so this test never touches a real DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deterministic terminal prompt (no TTY).
let answer = '';
const questionMock = vi.fn(async () => answer);
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: questionMock, close: vi.fn() }),
}));

// Mock the pending-actions service (the web path I/O boundary).
const createPendingAction = vi.fn();
const pollPendingAction = vi.fn();
const getPendingAction = vi.fn();
vi.mock('@/lib/cockpit/pending-actions-service', () => ({
  createPendingAction: (...a: unknown[]) => createPendingAction(...a),
  pollPendingAction: (...a: unknown[]) => pollPendingAction(...a),
  getPendingAction: (...a: unknown[]) => getPendingAction(...a),
}));

import { requireApproval } from '../../../scripts/_skill-runtime';
import type { PendingActionProposal } from '@/types/cockpit';

const proposal: PendingActionProposal = {
  intent: { clientIntentId: 'i', sessionId: 's', coin: 'ETH', side: 'sell', sz: 1.5, reduceOnly: true, createdAt: 0 },
  display: { coin: 'ETH', side: 'sell', sz: 1.5, rationale: 'exit' },
};

beforeEach(() => {
  answer = '';
  questionMock.mockClear();
  createPendingAction.mockReset();
  pollPendingAction.mockReset();
  getPendingAction.mockReset();
  delete process.env.HL_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_HL_SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.HL_SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.HL_SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe('requireApproval — terminal fallback (no session / no Supabase)', () => {
  it('no sessionId ⇒ uses the terminal gate; paper one-tap "yes" approves', async () => {
    answer = 'yes';
    const r = await requireApproval({ kind: 'entry', proposal, mode: 'paper', args: {} });
    expect(r.approved).toBe(true);
    // Terminal path has no slider — leverage is left to the proposal (undefined).
    expect(r.leverage).toBeUndefined();
    expect(questionMock).toHaveBeenCalledTimes(1);
    expect(createPendingAction).not.toHaveBeenCalled();
  });

  it('no sessionId + LIVE ⇒ terminal requires the exact "side sz coin" phrase', async () => {
    answer = 'yes'; // a bare yes must NOT fire a live order
    const reject = await requireApproval({ kind: 'exit', proposal, mode: 'live', args: {} });
    expect(reject.approved).toBe(false);

    answer = 'sell 1.5 eth';
    const accept = await requireApproval({ kind: 'exit', proposal, mode: 'live', args: {} });
    expect(accept.approved).toBe(true);
  });

  it('session present but Supabase unconfigured ⇒ still terminal fallback', async () => {
    answer = 'yes';
    const r = await requireApproval({ sessionId: 's1', kind: 'entry', proposal, mode: 'paper', args: {} });
    expect(r.approved).toBe(true);
    expect(createPendingAction).not.toHaveBeenCalled();
  });
});

describe('requireApproval — web path (session + Supabase)', () => {
  beforeEach(() => {
    process.env.HL_SUPABASE_URL = 'https://example.supabase.co';
    process.env.HL_SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    createPendingAction.mockResolvedValue({ id: 'pa1' });
  });

  it('writes a pending row and resolves TRUE when the poll approves', async () => {
    pollPendingAction.mockResolvedValue(true);
    // Approved row carries the operator's server-validated leverage in its proposal.
    getPendingAction.mockResolvedValue({
      proposal: { intent: { ...proposal.intent, leverage: 7 }, display: proposal.display },
    });
    const r = await requireApproval({ sessionId: 's1', kind: 'entry', proposal, mode: 'paper' });
    expect(r.approved).toBe(true);
    // The leverage read off the approved row flows back to the caller (→ executeIntent).
    expect(r.leverage).toBe(7);
    expect(createPendingAction).toHaveBeenCalledTimes(1);
    expect(pollPendingAction).toHaveBeenCalledWith('pa1', expect.any(Object));
    expect(questionMock).not.toHaveBeenCalled(); // never fell back to terminal
  });

  it('falls back to the proposal leverage when the row read fails (fail-soft)', async () => {
    pollPendingAction.mockResolvedValue(true);
    getPendingAction.mockRejectedValue(new Error('read failed'));
    const propWithLev = { intent: { ...proposal.intent, leverage: 3 }, display: proposal.display };
    const r = await requireApproval({ sessionId: 's1', kind: 'entry', proposal: propWithLev, mode: 'paper' });
    expect(r.approved).toBe(true);
    expect(r.leverage).toBe(3);
  });

  it('resolves FALSE when the poll does not approve (reject/timeout)', async () => {
    pollPendingAction.mockResolvedValue(false);
    const r = await requireApproval({ sessionId: 's1', kind: 'exit', proposal, mode: 'live' });
    expect(r.approved).toBe(false);
    // Not approved ⇒ never reads the row back.
    expect(getPendingAction).not.toHaveBeenCalled();
  });
});
