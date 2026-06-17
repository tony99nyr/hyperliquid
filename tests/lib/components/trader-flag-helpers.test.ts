import { describe, it, expect } from 'vitest';
import {
  describeFlag,
  describeFlags,
  followVerdict,
} from '@/app/cockpit/components/left-rail/trader-flag-helpers';

describe('describeFlag', () => {
  it('describes a known danger flag with a meaning', () => {
    const d = describeFlag('DEEP_MARTINGALE');
    expect(d.severity).toBe('danger');
    expect(d.label).toBe('Deep Martingale');
    expect(d.meaning.length).toBeGreaterThan(0);
  });

  it('describes a known clean flag as clean', () => {
    expect(describeFlag('CLEAN_BOOK').severity).toBe('clean');
  });

  it('describes a known warn flag as warn', () => {
    expect(describeFlag('LIVE_DEEP_STACK').severity).toBe('warn');
  });

  it('pretty-prints ad-hoc threshold flags with a caution', () => {
    const d = describeFlag('worstLossVsMedianWin>80');
    expect(d.label).toBe('worstLossVsMedianWin > 80');
    expect(d.severity === 'danger' || d.severity === 'warn').toBe(true);
    expect(d.meaning).toMatch(/threshold/i);
  });

  it('falls back gracefully for a truly unknown flag', () => {
    const d = describeFlag('SOME_NEW_FLAG');
    expect(d.label).toBe('Some New Flag');
    expect(d.meaning).toMatch(/no description/i);
    // Unknown + in the canonical RISK set would be danger; not in set → info.
    expect(d.severity).toBe('info');
  });

  it('a known risk-set danger flag stays danger', () => {
    expect(describeFlag('BLOW_UP_RISK').severity).toBe('danger');
  });
});

describe('describeFlags ordering', () => {
  it('sorts worst-first (danger → warn → info → clean)', () => {
    const out = describeFlags(['CLEAN_BOOK', 'LIVE_DEEP_STACK', 'DEEP_MARTINGALE', 'NO_FILL_DATA']);
    expect(out.map((d) => d.severity)).toEqual(['danger', 'warn', 'info', 'clean']);
  });

  it('handles an empty flag list', () => {
    expect(describeFlags([])).toEqual([]);
  });
});

describe('followVerdict', () => {
  it('flags a high-risk wallet when a danger flag is present', () => {
    const v = followVerdict(['DEEP_MARTINGALE'], 8);
    expect(v.level).toBe('danger');
    expect(v.headline).toMatch(/do not copy/i);
  });

  it('cautions when only warn flags are present', () => {
    expect(followVerdict(['LIVE_DEEP_STACK'], 6).level).toBe('warn');
  });

  it('reads clean for a no-flag, strong-composite wallet', () => {
    expect(followVerdict(['CLEAN_BOOK'], 9).level).toBe('clean');
  });

  it('reads info for no flags but a mediocre composite', () => {
    expect(followVerdict([], 4).level).toBe('info');
  });
});
