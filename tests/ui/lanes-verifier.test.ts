import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { allowLanesConsoleError, endpointsMatch, hasRawIsoTimestamp, loadLanesFixture, markerLegendState, orderedUnique, hasVisibleChartVariation, pathYValues } from '../../scripts/lanes-verifier-helpers';
import { lanePerformanceReportFixture } from '../fixtures/lane-performance-report.fixture';

describe('lanes browser verifier support', () => {
  it('allows only resource errors during a deliberate failure step', () => {
    expect(allowLanesConsoleError('Failed to load resource: HTTP 500', 'get-500')).toBe(true);
    expect(allowLanesConsoleError('Failed to load resource: HTTP 404', 'get-404')).toBe(true);
    expect(allowLanesConsoleError('Failed to load resource: HTTP 500', null)).toBe(false);
    expect(allowLanesConsoleError('Unhandled application error', 'get-500')).toBe(false);
    expect(allowLanesConsoleError('TypeError: crashed', 'confirm-500')).toBe(false);
  });

  it('uses a synthetic default fixture and an explicit local JSON path', async () => {
    const fixture = await loadLanesFixture();
    expect(fixture).toBe(lanePerformanceReportFixture);
    expect(fixture.lanes).toHaveLength(10);
    expect(fixture.forecast.fan).toHaveLength(30);
    expect(fixture.overview.live.length).toBeGreaterThan(30);
    expect(new Set(fixture.lanes.map((lane) => lane.verdict))).toEqual(new Set(['KILL', 'CONTINUE', 'COLLECT', 'HOLD', 'UNREGISTERED']));
    const directory = await mkdtemp(join(tmpdir(), 'lanes-fixture-'));
    try {
      const path = join(directory, 'report.json');
      const local = { ...fixture, generatedAt: '2026-01-01T00:00:00Z' };
      await writeFile(path, JSON.stringify(local));
      expect((await loadLanesFixture(path)).generatedAt).toBe(local.generatedAt);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('checks raw ISO dates across the view while excluding the backend notes strip', () => {
    expect(hasRawIsoTimestamp('overview 2026-10-24T12:00:00Z', 'notes')).toBe(true);
    expect(hasRawIsoTimestamp('Stale report from 2026-10-24T12:00:00.000Z', ['backend note'])).toBe(true);
    expect(hasRawIsoTimestamp('overview without a date; backend note 2026-10-24T12:00:00Z', 'backend note 2026-10-24T12:00:00Z')).toBe(false);
  });

  it('requires marker legend only when confirmed markers exist and recognises the migration empty state', () => {
    const empty = { ...lanePerformanceReportFixture, markers: [], notes: ['No marker data, migration-0046 has not run.'] };
    const plainEmpty = { ...empty, notes: ['No marker data.'] };
    expect(markerLegendState(lanePerformanceReportFixture)).toBe('legend');
    expect(markerLegendState(empty)).toBe('migration-empty');
    expect(markerLegendState(plainEmpty)).toBe('empty');
    expect(markerLegendState({ ...plainEmpty, markers: [lanePerformanceReportFixture.markers[2]!] })).toBe('proposed');
  });

  it('checks ordered unique chart tick positions', () => {
    expect(orderedUnique([1, 2, 3])).toBe(true);
    expect(orderedUnique([1, 1, 2])).toBe(false);
    expect(orderedUnique([2, 1])).toBe(false);
  });

  it('requires line paths to span height and contain several distinct y values', () => {
    expect(hasVisibleChartVariation({ height: 21, yValues: [5, 15, 30, 8] })).toBe(true);
    expect(hasVisibleChartVariation({ height: 20, yValues: [5, 15, 30, 8] })).toBe(false);
    expect(hasVisibleChartVariation({ height: 30, yValues: [5, 15, 5, 15] })).toBe(false);
  });

  it('allows at most two pixels between the live endpoint and forecast start', () => {
    expect(endpointsMatch(24, 26)).toBe(true);
    expect(endpointsMatch(24, 26.1)).toBe(false);
  });

  it('reads every y coordinate from a curved SVG line', () => {
    expect(pathYValues('M0,10C1,15 2,20 3,25L4,30')).toEqual([10, 15, 20, 25, 30]);
  });
});
