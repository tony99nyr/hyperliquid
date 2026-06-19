import { describe, it, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseMock, type SupabaseMock } from '../../mocks/supabase.mock';
import { openSession, closeSession } from '@/lib/cockpit/session-service';
import { writeAnalysisLog } from '@/lib/cockpit/analysis-log-service';
import { writeHypothesis, resolveHypothesis } from '@/lib/cockpit/hypothesis-service';
import { writeHealthSnapshot } from '@/lib/cockpit/health-snapshot-service';
import { writeContextGauge } from '@/lib/cockpit/context-gauge-service';

let mock: SupabaseMock;
let client: SupabaseClient;

beforeEach(() => {
  mock = createSupabaseMock();
  client = mock.client as unknown as SupabaseClient;
});

describe('session-service', () => {
  it('openSession inserts an active session row + returns the mapped Session', async () => {
    mock.queueResult({
      data: {
        id: 'sess-1',
        created_at: '2026-01-01T00:00:00.000Z',
        status: 'active',
        mode: 'paper',
        title: 'follow whale',
        leader_address: '0xabc',
      },
      error: null,
    });

    const session = await openSession(
      { mode: 'paper', title: 'follow whale', leaderAddress: '0xabc' },
      client,
    );

    expect(mock.ops).toHaveLength(1);
    expect(mock.ops[0].table).toBe('sessions');
    expect(mock.ops[0].op).toBe('insert');
    expect(mock.ops[0].payload).toEqual({
      status: 'active',
      mode: 'paper',
      title: 'follow whale',
      leader_address: '0xabc',
    });
    expect(session.id).toBe('sess-1');
    expect(session.createdAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(session.leaderAddress).toBe('0xabc');
  });

  it('closeSession updates status to closed filtered by id', async () => {
    await closeSession('sess-1', client);
    const op = mock.ops[0];
    expect(op.table).toBe('sessions');
    expect(op.op).toBe('update');
    expect(op.payload).toEqual({ status: 'closed' });
    expect(op.filters).toEqual([{ column: 'id', value: 'sess-1' }]);
  });

  it('throws when the insert errors', async () => {
    mock.queueResult({ error: { message: 'boom' } });
    await expect(openSession({ mode: 'paper' }, client)).rejects.toThrow(/openSession failed: boom/);
  });
});

describe('analysis-log-service', () => {
  it('writes an analysis_log row with default severity', async () => {
    await writeAnalysisLog({ sessionId: 's1', source: 'analyze-market', message: 'regime bullish' }, client);
    const op = mock.ops[0];
    expect(op.table).toBe('analysis_log');
    expect(op.op).toBe('insert');
    expect(op.payload).toEqual({
      session_id: 's1',
      source: 'analyze-market',
      severity: 'info',
      message: 'regime bullish',
    });
  });

  it('propagates a danger severity', async () => {
    await writeAnalysisLog(
      { sessionId: 's1', source: 'assess-health', message: 'stop near', severity: 'danger' },
      client,
    );
    expect((mock.ops[0].payload as { severity: string }).severity).toBe('danger');
  });
});

describe('hypothesis-service', () => {
  it('writeHypothesis inserts an open hypothesis + maps the returned row', async () => {
    mock.queueResult({
      data: {
        id: 'hyp-1',
        session_id: 's1',
        created_at: '2026-01-02T00:00:00.000Z',
        statement: 'ETH reclaims 3k',
        status: 'open',
        resolved_at: null,
        resolution_note: null,
      },
      error: null,
    });
    const hyp = await writeHypothesis({ sessionId: 's1', statement: 'ETH reclaims 3k' }, client);
    expect(mock.ops[0].table).toBe('hypotheses');
    expect(mock.ops[0].payload).toEqual({ session_id: 's1', statement: 'ETH reclaims 3k', status: 'open' });
    expect(hyp.status).toBe('open');
    expect(hyp.resolvedAt).toBeNull();
  });

  it('resolveHypothesis updates terminal status + stamps resolved_at', async () => {
    await resolveHypothesis(
      { hypothesisId: 'hyp-1', status: 'confirmed', resolutionNote: 'target hit' },
      client,
    );
    const op = mock.ops[0];
    expect(op.table).toBe('hypotheses');
    expect(op.op).toBe('update');
    const payload = op.payload as { status: string; resolved_at: string; resolution_note: string };
    expect(payload.status).toBe('confirmed');
    expect(payload.resolution_note).toBe('target hit');
    expect(typeof payload.resolved_at).toBe('string');
    expect(op.filters).toEqual([{ column: 'id', value: 'hyp-1' }]);
  });
});

describe('health-snapshot-service', () => {
  it('writes a health_snapshots row with probs + alerts', async () => {
    await writeHealthSnapshot(
      { sessionId: 's1', coin: 'ETH', score: 80, pContinuation: 0.65, pAdverse: 0.25, alerts: ['regime-flip-8h'] },
      client,
    );
    const op = mock.ops[0];
    expect(op.table).toBe('health_snapshots');
    expect(op.payload).toEqual({
      session_id: 's1',
      coin: 'ETH',
      score: 80,
      p_continuation: 0.65,
      p_adverse: 0.25,
      alerts: ['regime-flip-8h'],
    });
  });
});

describe('context-gauge-service', () => {
  it('writes a context_gauge row + returns the classified zone', async () => {
    const zone = await writeContextGauge({ sessionId: 's1', approxPct: 70 }, client);
    expect(zone).toBe('warn');
    const op = mock.ops[0];
    expect(op.table).toBe('context_gauge');
    expect(op.payload).toEqual({ session_id: 's1', approx_pct: 70, zone: 'warn' });
  });

  it('classifies a high reading as critical', async () => {
    const zone = await writeContextGauge({ sessionId: 's1', approxPct: 92 }, client);
    expect(zone).toBe('critical');
    expect((mock.ops[0].payload as { zone: string }).zone).toBe('critical');
  });
});
