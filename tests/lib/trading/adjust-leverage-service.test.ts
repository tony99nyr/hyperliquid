import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTradingMode = vi.fn();
const submitUpdateLeverage = vi.fn();
vi.mock('@/lib/env/mode', () => ({ getTradingMode: (...args: unknown[]) => getTradingMode(...args) }));
vi.mock('@/lib/hyperliquid/hyperliquid-exchange-service', () => ({ submitUpdateLeverage: (...args: unknown[]) => submitUpdateLeverage(...args) }));

import { applyLeverageOnHl } from '@/lib/trading/adjust-leverage-service';

describe('applyLeverageOnHl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never submits an exchange update in paper mode', async () => {
    getTradingMode.mockReturnValue('paper');
    await expect(applyLeverageOnHl('ETH', 5)).resolves.toEqual({ pushed: false, mode: 'paper' });
    expect(submitUpdateLeverage).not.toHaveBeenCalled();
  });
});
