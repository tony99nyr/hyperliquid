import { describe, it, expect } from 'vitest';
import { assertScoutPaperMode, ScoutLiveExecutionError } from '@/lib/scout/scout-execution-guard';

describe('assertScoutPaperMode — no-auto-fire-for-real-money guarantee', () => {
  it('permits paper mode', () => {
    expect(() => assertScoutPaperMode('paper')).not.toThrow();
  });

  it('REFUSES live mode (scout never auto-fires real funds)', () => {
    expect(() => assertScoutPaperMode('live')).toThrow(ScoutLiveExecutionError);
  });
});
