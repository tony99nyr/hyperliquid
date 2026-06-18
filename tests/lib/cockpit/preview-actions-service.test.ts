/**
 * Pins the OPERATOR-PREVIEW lifecycle guardrails (the safety-critical, route-
 * driven execute path). The design review flagged these as the highest-risk
 * areas — they are locked here:
 *
 *   - createPreview writes status='preview', origin='operator' (never executes).
 *   - claimPreviewForExecute is the ATOMIC anti-double-fire claim: it flips
 *     preview→executing ONLY when the row is still an operator preview, guarded on
 *     BOTH status='preview' AND origin='operator', and stamps the validated
 *     leverage in the SAME update. A skill 'pending' row is refused (no update).
 *   - discardPreview / finalize / revert all carry their status+origin guards so
 *     the two execution paths (skill 'pending' vs operator 'preview') stay isolated.
 *
 * The Supabase client is the recording mock; we assert WHICH guards each write
 * carries (filters) and WHAT it writes (payload).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createSupabaseMock } from '../../mocks/supabase.mock';
import {
  createPreview,
  claimPreviewForExecute,
  discardPreview,
  attachPreviewReview,
  finalizeExecutedPreview,
  revertClaimedPreview,
} from '@/lib/cockpit/pending-actions-service';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PendingActionProposal } from '@/types/cockpit';

let mock: ReturnType<typeof createSupabaseMock>;
const client = () => mock.client as unknown as SupabaseClient;

const proposal: PendingActionProposal = {
  intent: { clientIntentId: 'i1', sessionId: 's1', coin: 'BTC', side: 'sell', sz: 0.03, reduceOnly: false, createdAt: 0 },
  display: { coin: 'BTC', side: 'sell', sz: 0.03, rationale: 'mirror', coinMaxLeverage: 20 },
};

function previewRow(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    session_id: 's1',
    kind: 'entry',
    mode: 'paper',
    proposal,
    status: 'preview',
    origin: 'operator',
    review: null,
    created_at: new Date(0).toISOString(),
    decided_at: null,
    ...over,
  };
}

const hasFilter = (filters: Array<{ column: string; value: unknown }>, column: string, value: unknown) =>
  filters.some((f) => f.column === column && f.value === value);

beforeEach(() => {
  mock = createSupabaseMock();
});

describe('createPreview — operator-authored, executes nothing', () => {
  it('inserts status=preview, origin=operator', async () => {
    mock.queueResult({ data: previewRow(), error: null });
    await createPreview({ sessionId: 's1', kind: 'entry', mode: 'paper', proposal }, client());
    const ins = mock.ops[0];
    expect(ins.op).toBe('insert');
    const payload = ins.payload as { status: string; origin: string };
    expect(payload.status).toBe('preview');
    expect(payload.origin).toBe('operator');
  });
});

describe('claimPreviewForExecute — atomic anti-double-fire claim', () => {
  it('claims a valid operator preview → executing, stamping the validated leverage, guarded on status+origin', async () => {
    mock.queueResult({ data: previewRow(), error: null }); // getPendingAction
    mock.queueResult({ data: [previewRow({ status: 'executing' })], error: null }); // the claim update
    const claimed = await claimPreviewForExecute('p1', 8, client());
    expect(claimed).not.toBeNull();

    const upd = mock.ops.find((o) => o.op === 'update')!;
    const payload = upd.payload as { status: string; proposal: PendingActionProposal };
    expect(payload.status).toBe('executing');
    // Leverage stamped onto BOTH intent + display in the SAME update.
    expect(payload.proposal.intent.leverage).toBe(8);
    expect(payload.proposal.display.leverage).toBe(8);
    // The claim is guarded so exactly one caller can win + a skill row can't slip in.
    expect(hasFilter(upd.filters, 'status', 'preview')).toBe(true);
    expect(hasFilter(upd.filters, 'origin', 'operator')).toBe(true);
  });

  it('REFUSES a skill pending row — no claim, no update issued', async () => {
    mock.queueResult({ data: previewRow({ status: 'pending', origin: 'skill' }), error: null });
    const claimed = await claimPreviewForExecute('p1', 8, client());
    expect(claimed).toBeNull();
    expect(mock.ops.some((o) => o.op === 'update')).toBe(false);
  });

  it('returns null when the claim update affects 0 rows (lost the race / already claimed)', async () => {
    mock.queueResult({ data: previewRow(), error: null });
    mock.queueResult({ data: [], error: null }); // update matched nothing
    const claimed = await claimPreviewForExecute('p1', 8, client());
    expect(claimed).toBeNull();
  });

  it('does NOT stamp leverage on a reduce-only intent', async () => {
    const ro = previewRow({ proposal: { intent: { ...proposal.intent, reduceOnly: true }, display: proposal.display } });
    mock.queueResult({ data: ro, error: null });
    mock.queueResult({ data: [ro], error: null });
    await claimPreviewForExecute('p1', 8, client());
    const upd = mock.ops.find((o) => o.op === 'update')!;
    const payload = upd.payload as { proposal: PendingActionProposal };
    expect(payload.proposal.intent.leverage).toBeUndefined();
  });
});

describe('discardPreview — preview→rejected, never executes', () => {
  it('flips to rejected, guarded on status=preview + origin=operator', async () => {
    mock.queueResult({ data: [{ id: 'p1' }], error: null });
    const ok = await discardPreview('p1', client());
    expect(ok).toBe(true);
    const upd = mock.ops[0];
    expect((upd.payload as { status: string }).status).toBe('rejected');
    expect(hasFilter(upd.filters, 'status', 'preview')).toBe(true);
    expect(hasFilter(upd.filters, 'origin', 'operator')).toBe(true);
  });

  it('returns false when nothing matched (already decided)', async () => {
    mock.queueResult({ data: [], error: null });
    expect(await discardPreview('p1', client())).toBe(false);
  });
});

describe('finalize / revert — guarded on the executing claim', () => {
  it('finalizeExecutedPreview writes executed, guarded on status=executing', async () => {
    mock.queueResult({ data: null, error: null });
    await finalizeExecutedPreview('p1', client());
    const upd = mock.ops[0];
    expect((upd.payload as { status: string }).status).toBe('executed');
    expect(hasFilter(upd.filters, 'status', 'executing')).toBe(true);
  });

  it('revertClaimedPreview restores preview, guarded on status=executing', async () => {
    mock.queueResult({ data: null, error: null });
    await revertClaimedPreview('p1', client());
    const upd = mock.ops[0];
    expect((upd.payload as { status: string }).status).toBe('preview');
    expect(hasFilter(upd.filters, 'status', 'executing')).toBe(true);
  });
});

describe('attachPreviewReview — advisory, guarded on operator preview', () => {
  it('writes the review, guarded on status=preview + origin=operator', async () => {
    mock.queueResult({ data: [{ id: 'p1' }], error: null });
    const ok = await attachPreviewReview('p1', { verdict: 'endorse', note: 'looks clean', reviewedAt: 1 }, client());
    expect(ok).toBe(true);
    const upd = mock.ops[0];
    expect((upd.payload as { review: { verdict: string } }).review.verdict).toBe('endorse');
    expect(hasFilter(upd.filters, 'status', 'preview')).toBe(true);
    expect(hasFilter(upd.filters, 'origin', 'operator')).toBe(true);
  });
});
