import { readFile } from 'node:fs/promises';
import { lanePerformanceReportFixture } from '../tests/fixtures/lane-performance-report.fixture';
import type { LanePerformanceReport } from '../src/lib/performance/lane-performance-business-logic';

export type LanesFailureStep = 'get-404' | 'get-401' | 'get-500' | 'get-non-json' | 'get-network' | 'confirm-500' | null;

export function allowLanesConsoleError(message: string, failureStep: LanesFailureStep): boolean {
  return failureStep !== null && message.startsWith('Failed to load resource');
}

export async function loadLanesFixture(path?: string): Promise<LanePerformanceReport> {
  if (!path) return lanePerformanceReportFixture;
  return JSON.parse(await readFile(path, 'utf8')) as LanePerformanceReport;
}

export function hasRawIsoTimestamp(viewText: string, backendNotesText: string | string[] = ''): boolean {
  const notes = Array.isArray(backendNotesText) ? backendNotesText : [backendNotesText];
  const visibleText = notes.reduce((text, note) => note ? text.replace(note, '') : text, viewText);
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(visibleText);
}

export function markerLegendState(report: LanePerformanceReport): 'legend' | 'proposed' | 'migration-empty' | 'empty' {
  if (report.markers.some((marker) => marker.confirmed_at !== null)) return 'legend';
  if (report.markers.length) return 'proposed';
  return report.notes.some((note) => /0046/.test(note)) ? 'migration-empty' : 'empty';
}

export function orderedUnique(values: number[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

export function hasVisibleChartVariation(path: { height: number; yValues: number[] }): boolean {
  return path.height > 20 && new Set(path.yValues.map((value) => Math.round(value * 10) / 10)).size > 3;
}

export function endpointsMatch(liveEndY: number, forecastStartY: number): boolean {
  return Math.abs(liveEndY - forecastStartY) <= 2;
}

export function pathYValues(path: string): number[] {
  return [...path.matchAll(/[-+\d.eE]+[, ]+([-+\d.eE]+)/g)].map((match) => Number(match[1]));
}
