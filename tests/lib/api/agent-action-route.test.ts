/**
 * Pins the scoped agent-action route (ADR-0009), a surface that reaches real money.
 * The kill switch must block before auth, only the dedicated token may pass, and a
 * bad request must never reach the service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyCronBearer = vi.fn();
const tightenStop = vi.fn();
const reduceClose = vi.fn();
const placeTakeProfit = vi.fn();
const isAgentActionsEnabled = vi.fn();
const getAgentActionToken = vi.fn();

vi.mock('@/lib/infrastructure/auth/auth', () => ({
  verifyCronBearer: (...a: unknown[]) => verifyCronBearer(...a),
  getClientIdentifier: () => 'test-client',
}));
vi.mock('@/lib/agent-actions/agent-action-service', () => ({
  tightenStop: (...a: unknown[]) => tightenStop(...a),
  reduceClose: (...a: unknown[]) => reduceClose(...a),
  placeTakeProfit: (...a: unknown[]) => placeTakeProfit(...a),
}));
vi.mock('@/lib/agent-actions/agent-action-config', () => ({
  isAgentActionsEnabled: () => isAgentActionsEnabled(),
  getAgentActionToken: () => getAgentActionToken(),
}));

import { POST } from '@/app/api/agent/action/route';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import type { NextRequest } from 'next/server';

function req(body: unknown = { action: 'tighten-stop', coin: 'HYPE', triggerPx: 66.5 }): NextRequest {
  return {
    json: async () => {
      if (body === '__throw__') throw new Error('bad json');
      return body;
    },
    headers: { get: () => null },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  isAgentActionsEnabled.mockReturnValue(true);
  getAgentActionToken.mockReturnValue('t'.repeat(40));
  verifyCronBearer.mockReturnValue(true);
  tightenStop.mockResolvedValue({ done: true, skipped: null, coin: 'HYPE', newStopPx: 66.5 });
  reduceClose.mockResolvedValue({ done: true, skipped: null, coin: 'HYPE', filledSz: 1 });
  placeTakeProfit.mockResolvedValue({ done: true, skipped: null, coin: 'ETH', takeProfitPx: 1519 });
});

describe('POST /api/agent/action', () => {
  it('refuses everything when the kill switch is off, before auth', async () => {
    isAgentActionsEnabled.mockReturnValue(false);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(verifyCronBearer).not.toHaveBeenCalled();
    expect(tightenStop).not.toHaveBeenCalled();
  });

  it('refuses a request without the token', async () => {
    verifyCronBearer.mockReturnValue(false);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(tightenStop).not.toHaveBeenCalled();
    expect(reduceClose).not.toHaveBeenCalled();
  });

  it('checks the bearer against the dedicated token', async () => {
    await POST(req());
    expect(verifyCronBearer).toHaveBeenCalledWith(expect.anything(), 't'.repeat(40));
  });

  it('refuses invalid JSON and an invalid request without reaching the service', async () => {
    expect((await POST(req('__throw__'))).status).toBe(400);
    expect((await POST(req({ action: 'open', coin: 'HYPE' }))).status).toBe(400);
    expect((await POST(req({ action: 'reduce', coin: 'HYPE', fraction: 2 }))).status).toBe(400);
    expect(tightenStop).not.toHaveBeenCalled();
    expect(reduceClose).not.toHaveBeenCalled();
  });

  it('routes tighten-stop to the service and returns 200', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(tightenStop).toHaveBeenCalledWith({ coin: 'HYPE', triggerPx: 66.5 });
    expect(await res.json()).toMatchObject({ ok: true, action: 'tighten-stop', newStopPx: 66.5 });
  });

  it('routes reduce to the service with the fraction only', async () => {
    const res = await POST(req({ action: 'reduce', coin: 'hype', fraction: 0.4, side: 'buy', sz: 99 }));
    expect(res.status).toBe(200);
    expect(reduceClose).toHaveBeenCalledWith({ coin: 'HYPE', fraction: 0.4 });
  });

  it('returns 409 when the service refuses', async () => {
    tightenStop.mockResolvedValue({ done: false, skipped: 'not-tighter-than-resting-stop', coin: 'HYPE' });
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, skipped: 'not-tighter-than-resting-stop' });
  });

  it('returns 500 when the service throws (unknown outcome)', async () => {
    reduceClose.mockRejectedValue(new Error('network lost'));
    const res = await POST(req({ action: 'reduce', coin: 'HYPE', fraction: 1 }));
    expect(res.status).toBe(500);
  });

  it('rate-limits after six requests in a minute', async () => {
    for (let i = 0; i < 6; i++) expect((await POST(req())).status).toBe(200);
    expect((await POST(req())).status).toBe(429);
  });

  it('routes a take-profit to the take-profit service only', async () => {
    const res = await POST(req({ action: 'take-profit', coin: 'ETH', triggerPx: 1519 }));
    expect(res.status).toBe(200);
    expect(placeTakeProfit).toHaveBeenCalledWith({ coin: 'ETH', triggerPx: 1519 });
    expect(tightenStop).not.toHaveBeenCalled();
    expect(reduceClose).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ ok: true, action: 'take-profit', takeProfitPx: 1519 });
  });

  it('answers 409 when the take-profit is refused', async () => {
    placeTakeProfit.mockResolvedValue({ done: false, skipped: 'take-profit-already-rests', coin: 'ETH' });
    const res = await POST(req({ action: 'take-profit', coin: 'ETH', triggerPx: 1519 }));
    expect(res.status).toBe(409);
  });
});
