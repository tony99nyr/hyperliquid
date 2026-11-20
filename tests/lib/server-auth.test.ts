import { describe, it, expect, vi, beforeEach } from 'vitest';

const cookieValue = vi.fn();
const headerValue = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: cookieValue() }) }),
  headers: async () => ({ get: (k: string) => headerValue(k) }),
}));

import { getPageAuthRole, VIEWER_PAGE_LOADS_PER_MIN } from '@/lib/infrastructure/auth/server-auth';
import { issueSessionToken, issueViewerSessionToken } from '@/lib/infrastructure/auth/auth';
import { _resetRateLimits } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimits();
  process.env.VIEWER_PIN = 'viewer-test-pin';
  headerValue.mockImplementation((k: string) => (k === 'x-real-ip' ? '10.1.1.1' : null));
});

describe('getPageAuthRole', () => {
  it('returns null with no valid cookie', async () => {
    cookieValue.mockReturnValue(undefined);
    expect(await getPageAuthRole()).toBeNull();
  });

  it('caps the page loads of one viewer client and leaves an admin uncapped', async () => {
    cookieValue.mockReturnValue(issueViewerSessionToken(60));
    for (let i = 0; i < VIEWER_PAGE_LOADS_PER_MIN; i++) expect(await getPageAuthRole()).toBe('viewer');
    expect(await getPageAuthRole()).toBeNull();
    cookieValue.mockReturnValue(issueSessionToken(60));
    expect(await getPageAuthRole()).toBe('admin');
  });
});
