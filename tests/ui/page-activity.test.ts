import { describe, it, expect } from 'vitest';
import { pageIsActive, DEFAULT_IDLE_MS } from '@/hooks/page-activity';

describe('pageIsActive — the stop-polling-when-nobody-is-there decision', () => {
  const NOW = 1_700_000_000_000;

  it('hidden tab is never active, regardless of input recency', () => {
    expect(pageIsActive(NOW, NOW, true, DEFAULT_IDLE_MS)).toBe(false);
  });
  it('visible + recent input = active', () => {
    expect(pageIsActive(NOW, NOW - 60_000, false, DEFAULT_IDLE_MS)).toBe(true);
  });
  it('visible but idle past the window = inactive (the unattended-monitor case)', () => {
    expect(pageIsActive(NOW, NOW - DEFAULT_IDLE_MS - 1, false, DEFAULT_IDLE_MS)).toBe(false);
  });
  it('exactly at the window boundary is still active', () => {
    expect(pageIsActive(NOW, NOW - DEFAULT_IDLE_MS, false, DEFAULT_IDLE_MS)).toBe(true);
  });
});
