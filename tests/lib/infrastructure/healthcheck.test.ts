import { describe, it, expect } from 'vitest';
import { healthcheckUrl } from '@/lib/infrastructure/monitoring/healthcheck';

describe('healthcheckUrl', () => {
  it('pings the bare base on success', () => {
    expect(healthcheckUrl('https://hc-ping.com/abc', 'success')).toBe('https://hc-ping.com/abc');
  });

  it('appends the sub-path for start and fail', () => {
    expect(healthcheckUrl('https://hc-ping.com/abc', 'start')).toBe('https://hc-ping.com/abc/start');
    expect(healthcheckUrl('https://hc-ping.com/abc', 'fail')).toBe('https://hc-ping.com/abc/fail');
  });

  it('trims trailing slashes before composing', () => {
    expect(healthcheckUrl('https://hc-ping.com/abc/', 'success')).toBe('https://hc-ping.com/abc');
    expect(healthcheckUrl('https://hc-ping.com/abc//', 'start')).toBe('https://hc-ping.com/abc/start');
  });

  it('returns null for a missing/blank base so callers no-op', () => {
    expect(healthcheckUrl('', 'success')).toBeNull();
    expect(healthcheckUrl('   ', 'start')).toBeNull();
    expect(healthcheckUrl(undefined, 'fail')).toBeNull();
    expect(healthcheckUrl(null, 'success')).toBeNull();
  });
});
