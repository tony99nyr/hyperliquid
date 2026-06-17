import { describe, it, expect } from 'vitest';
import {
  pickMirrorTarget,
  buildMirrorCommand,
  shortAddr,
} from '@/app/cockpit/components/left-rail/mirror-command-helpers';
import type { HlPosition } from '@/lib/hyperliquid/hyperliquid-info-service';

function pos(over: Partial<HlPosition> = {}): HlPosition {
  return {
    coin: 'ETH',
    side: 'long',
    szi: 1,
    size: 1,
    entryPx: 2000,
    positionValue: 2000,
    unrealizedPnl: 0,
    returnOnEquity: null,
    leverage: 5,
    leverageType: 'cross',
    liquidationPx: null,
    marginUsed: 400,
    maxLeverage: 25,
    ...over,
  };
}

describe('pickMirrorTarget', () => {
  it('returns null when there are no positions', () => {
    expect(pickMirrorTarget([])).toBeNull();
  });

  it('picks the largest-notional position and maps long→buy', () => {
    const t = pickMirrorTarget([
      pos({ coin: 'ETH', positionValue: 1000 }),
      pos({ coin: 'BTC', positionValue: 5000 }),
    ]);
    expect(t?.coin).toBe('BTC');
    expect(t?.side).toBe('buy');
  });

  it('maps short→sell', () => {
    const t = pickMirrorTarget([pos({ coin: 'SOL', side: 'short', szi: -10, positionValue: 3000 })]);
    expect(t?.side).toBe('sell');
  });

  it('skips zero-size positions', () => {
    expect(pickMirrorTarget([pos({ size: 0, positionValue: 0 })])).toBeNull();
  });
});

describe('buildMirrorCommand', () => {
  const leader = '0x1234567890abcdef1234567890abcdef12345678';

  it('builds a run-session command from the target with sensible defaults', () => {
    const cmd = buildMirrorCommand({
      target: { coin: 'BTC', side: 'buy', notionalUsd: 5000 },
      leaderAddress: leader,
    });
    expect(cmd).toContain('pnpm skill:run-session');
    expect(cmd).toContain('--coin BTC');
    expect(cmd).toContain('--side buy');
    expect(cmd).toContain(`--leader ${leader}`);
    expect(cmd).toContain('--risk 100');
    expect(cmd).toContain('--stop-frac 0.05');
    expect(cmd).toContain('--thesis "mirror');
  });

  it('honors custom risk + stop-frac', () => {
    const cmd = buildMirrorCommand({
      target: { coin: 'ETH', side: 'sell', notionalUsd: 1000 },
      leaderAddress: leader,
      riskUsd: 250,
      stopFrac: 0.03,
    });
    expect(cmd).toContain('--risk 250');
    expect(cmd).toContain('--stop-frac 0.03');
    expect(cmd).toContain('--side sell');
  });

  it('the command never contains an order-execution verb (Claude-proposes / you-approve)', () => {
    const cmd = buildMirrorCommand({
      target: { coin: 'ETH', side: 'buy', notionalUsd: 1 },
      leaderAddress: leader,
    });
    // It surfaces the SKILL command, not a direct execute call.
    expect(cmd.startsWith('pnpm skill:run-session')).toBe(true);
    expect(cmd).not.toMatch(/executeIntent|--confirm/);
  });
});

describe('shortAddr', () => {
  it('shortens a full address', () => {
    expect(shortAddr('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
  });
  it('leaves short strings untouched', () => {
    expect(shortAddr('0xabc')).toBe('0xabc');
  });
});
