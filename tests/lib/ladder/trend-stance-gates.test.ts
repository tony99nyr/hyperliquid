/**
 * Pins the two PURE decision gates of the trend lane:
 *  - isBullishConfident — the entry gate (the retired leverage lane's exact contract:
 *    bullish AND ≥ 0.7 AND actually holding AND enabled).
 *  - isRegimeFlipped — the disarm gate (leaving bullish/holding = flip; an unreadable
 *    stance is NEVER a flip — fail-closed toward disarming on outages).
 */

import { describe, it, expect } from 'vitest';
import { isBullishConfident, TREND_BULLISH_CONF_MIN, type TrendStance } from '@/lib/ladder/trend-stance-service';
import { isRegimeFlipped } from '@/lib/ladder/trend-flip-guard-service';

const bullish: TrendStance = { asset: 'eth', enabled: true, position: 'holding', regime: 'bullish', regimeConfidence: 0.81 };

describe('isBullishConfident (entry gate)', () => {
  it('true only for enabled + holding + bullish ≥ 0.7', () => {
    expect(isBullishConfident(bullish)).toBe(true);
    expect(TREND_BULLISH_CONF_MIN).toBe(0.7); // the retired lane's exact bar — do not drift silently
  });
  it('confidence below the bar fails', () => {
    expect(isBullishConfident({ ...bullish, regimeConfidence: 0.69 })).toBe(false);
  });
  it('bullish but in CASH fails (amplify an expressed signal, never front-run one)', () => {
    expect(isBullishConfident({ ...bullish, position: 'cash' })).toBe(false);
  });
  it('a paused system (enabled=false) fails', () => {
    expect(isBullishConfident({ ...bullish, enabled: false })).toBe(false);
  });
  it('neutral/bearish regimes fail; null (unreadable) fails', () => {
    expect(isBullishConfident({ ...bullish, regime: 'neutral' })).toBe(false);
    expect(isBullishConfident({ ...bullish, regime: 'bearish' })).toBe(false);
    expect(isBullishConfident(null)).toBe(false);
  });
});

describe('isRegimeFlipped (disarm gate)', () => {
  it('still bullish + holding = not flipped, even if confidence sagged below the entry bar', () => {
    expect(isRegimeFlipped(bullish)).toBe(false);
    expect(isRegimeFlipped({ ...bullish, regimeConfidence: 0.4 })).toBe(false); // sag ≠ flip (the old unwind fired on regime ≠ bullish only)
  });
  it('leaving bullish flips; going to cash flips; a paused system flips', () => {
    expect(isRegimeFlipped({ ...bullish, regime: 'neutral' })).toBe(true);
    expect(isRegimeFlipped({ ...bullish, regime: 'bearish' })).toBe(true);
    expect(isRegimeFlipped({ ...bullish, position: 'cash' })).toBe(true);
    expect(isRegimeFlipped({ ...bullish, enabled: false })).toBe(true);
  });
  it('an unreadable stance (null) is NEVER a flip — outages must not disarm', () => {
    expect(isRegimeFlipped(null)).toBe(false);
  });
});
