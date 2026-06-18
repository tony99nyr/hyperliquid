/**
 * Orchestration test for submitOrder (Phase 3a) — wiring only, no key/network:
 * resolves the asset, builds the IOC action, signs (mocked lib), POSTs the right
 * URL/body, and parses the response into HlOrderResult. The crypto + the pure
 * order logic are covered elsewhere; this pins the I/O glue.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TradeIntent } from '@/types/fill';

const h = vi.hoisted(() => ({
  signL1Action: vi.fn(),
  privateKeyToAccount: vi.fn(() => ({ address: '0xagent' })),
  fetchPerpMeta: vi.fn(),
  fetchAllMids: vi.fn(),
}));
vi.mock('@nktkas/hyperliquid/signing', () => ({ signL1Action: h.signL1Action }));
vi.mock('viem/accounts', () => ({ privateKeyToAccount: h.privateKeyToAccount }));
vi.mock('@/lib/hyperliquid/hyperliquid-info-service', () => ({
  fetchPerpMeta: h.fetchPerpMeta,
  fetchAllMids: h.fetchAllMids,
}));

import { submitOrder } from '@/lib/hyperliquid/hyperliquid-exchange-service';

const intent = (over: Partial<TradeIntent> = {}): TradeIntent => ({
  clientIntentId: 'i1',
  sessionId: 's1',
  coin: 'ETH',
  side: 'buy',
  sz: 1.5,
  reduceOnly: false,
  createdAt: 0,
  ...over,
});

const FILLED = {
  status: 'ok',
  response: { type: 'order', data: { statuses: [{ filled: { totalSz: '1.5', avgPx: '2001', oid: 42 } }] } },
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  h.signL1Action.mockReset().mockResolvedValue({ r: '0x1', s: '0x2', v: 27 });
  h.privateKeyToAccount.mockReset().mockReturnValue({ address: '0xagent' });
  h.fetchPerpMeta.mockReset().mockResolvedValue([
    { name: 'BTC', szDecimals: 5 },
    { name: 'ETH', szDecimals: 4 },
  ]);
  h.fetchAllMids.mockReset().mockResolvedValue({ ETH: 2000 });
  process.env.HL_AGENT_PRIVATE_KEY = `0x${'1'.repeat(64)}`; // valid-shaped 32-byte hex
  delete process.env.HL_NETWORK;
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => FILLED }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.HL_AGENT_PRIVATE_KEY;
  delete process.env.HL_NETWORK;
});

describe('submitOrder', () => {
  it('full fill: builds the action, signs, POSTs mainnet, parses → HlOrderResult', async () => {
    const r = await submitOrder(intent());
    expect(r).toMatchObject({ avgPx: 2001, filledSz: 1.5, partial: false, hlOrderId: '42' });
    expect(r.feeUsd).toBeGreaterThan(0);
    // raw is narrowed to the bounded audit bits (status + statuses), not the envelope.
    expect(r.raw).toEqual({ status: 'ok', statuses: [{ filled: { totalSz: '1.5', avgPx: '2001', oid: 42 } }] });

    const signArg = h.signL1Action.mock.calls[0][0];
    expect(signArg.action.orders[0].a).toBe(1); // ETH index
    expect(signArg.action.orders[0].b).toBe(true); // buy
    expect(signArg.action.orders[0].t).toEqual({ limit: { tif: 'Ioc' } });
    expect(signArg.isTestnet).toBe(false);

    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('api.hyperliquid.xyz/exchange');
    const body = JSON.parse(opts.body);
    expect(body).toHaveProperty('action');
    expect(typeof body.nonce).toBe('number');
    expect(body.signature).toEqual({ r: '0x1', s: '0x2', v: 27 });
  });

  it('throws when the agent key is missing', async () => {
    delete process.env.HL_AGENT_PRIVATE_KEY;
    await expect(submitOrder(intent())).rejects.toThrow(/HL_AGENT_PRIVATE_KEY/);
  });

  it('refuses a sub-lot size that floors to 0 (never ships a zero-size order)', async () => {
    // ETH szDecimals 4 → 0.00005 floors to "0".
    await expect(submitOrder(intent({ sz: 0.00005 }))).rejects.toThrow(/rounds below the ETH lot size/);
  });

  it('resting IOC → filledSz 0, feeUsd 0', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 5 } }] } } }),
    });
    const r = await submitOrder(intent());
    expect(r.filledSz).toBe(0);
    expect(r.feeUsd).toBe(0);
    expect(r.hlOrderId).toBe('5');
  });

  it('uses a supplied limitPx instead of the mid', async () => {
    await submitOrder(intent({ limitPx: 1888 }));
    expect(h.fetchAllMids).not.toHaveBeenCalled();
    expect(h.signL1Action.mock.calls[0][0].action.orders[0].p).toBe('1888');
  });

  it('testnet env → POSTs the testnet URL + isTestnet true', async () => {
    process.env.HL_NETWORK = 'testnet';
    await submitOrder(intent());
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('hyperliquid-testnet.xyz');
    expect(h.signL1Action.mock.calls[0][0].isTestnet).toBe(true);
  });
});
