import { describe, it, expect } from 'vitest';
import { alertConditionMet, alertMessage } from '@/lib/ladder/price-alert-business-logic';

const below = { id: 'a', coin: 'HYPE', direction: 'below' as const, triggerPx: 62.6, message: 'arm the base-bid' };
const above = { id: 'b', coin: 'HYPE', direction: 'above' as const, triggerPx: 69.0, message: '' };

describe('alertConditionMet', () => {
  it('below fires at/under the trigger, above fires at/over', () => {
    expect(alertConditionMet(below, 62.6)).toBe(true);
    expect(alertConditionMet(below, 62.59)).toBe(true);
    expect(alertConditionMet(below, 62.61)).toBe(false);
    expect(alertConditionMet(above, 69.0)).toBe(true);
    expect(alertConditionMet(above, 68.99)).toBe(false);
  });

  it('bad marks and bad triggers never fire (fail-closed)', () => {
    expect(alertConditionMet(below, undefined)).toBe(false);
    expect(alertConditionMet(below, NaN)).toBe(false);
    expect(alertConditionMet(below, 0)).toBe(false);
    expect(alertConditionMet({ ...below, triggerPx: NaN }, 60)).toBe(false);
  });
});

describe('alertMessage', () => {
  it('includes coin, mark, direction arrow, trigger, and the operator note', () => {
    const msg = alertMessage(below, 62.55);
    expect(msg).toContain('HYPE');
    expect(msg).toContain('≤ 62.6');
    expect(msg).toContain('arm the base-bid');
    expect(alertMessage(above, 69.2)).not.toContain('\n');
  });
});
