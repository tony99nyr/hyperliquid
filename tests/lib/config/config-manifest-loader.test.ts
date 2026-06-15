import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseManifest, loadManifest, loadActiveConfig } from '@/lib/config/config-manifest-loader';
import type { HealthWeights } from '@/lib/health/health-engine-types';

const HEALTH_DIR = join(process.cwd(), 'data', 'health-engine');

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    const m = parseManifest({ active: '0.1.0', versions: { '0.1.0': 'f.json' } });
    expect(m.active).toBe('0.1.0');
    expect(m.versions['0.1.0']).toBe('f.json');
  });

  it('rejects a missing active', () => {
    expect(() => parseManifest({ versions: {} })).toThrow(/missing string "active"/);
  });

  it('rejects an active with no file entry', () => {
    expect(() => parseManifest({ active: '9.9.9', versions: { '0.1.0': 'f.json' } })).toThrow(
      /no file entry/,
    );
  });
});

describe('loadManifest + loadActiveConfig (real health-engine config on disk)', () => {
  it('loads the health-engine manifest', () => {
    const m = loadManifest(HEALTH_DIR);
    expect(m.active).toBe('0.1.0');
    expect(m.versions[m.active]).toMatch(/health-weights-v/);
  });

  it('loads the active health weights and they have the expected shape', () => {
    const w = loadActiveConfig<HealthWeights>(HEALTH_DIR);
    expect(w.version).toBe('0.1.0');
    expect(w.timeframeWeights['1d']).toBeGreaterThan(0);
    expect(w.timeframeWeights['15m']).toBeGreaterThan(0);
    expect(w.score.neutralBaseline).toBe(50);
    expect(w.probability.residualUncertainty).toBeGreaterThanOrEqual(0);
    expect(w.alerts.divergenceTimeframe).toBe('1h');
  });
});
