import { beforeAll, afterEach, afterAll, vi } from 'vitest';

// Suppress stdout noise during tests; keep stderr (errors/warnings) visible.
if (process.env.SUPPRESS_TEST_OUTPUT !== 'false') {
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
}

// Mock environment variables for testing (mirrors iamrossi's setup so the
// vendored auth tests pass: PIN '1234', admin secret 'test-admin-secret').
beforeAll(() => {
  process.env.ADMIN_SECRET = 'test-admin-secret';
  process.env.ADMIN_PIN = '1234';
  process.env.TRADING_MODE = 'paper';
});

afterEach(async () => {
  vi.clearAllMocks();
  // DOM cleanup for the jsdom (ui) project only — guarded so the node (lib)
  // project, which has no `document`, skips it.
  if (typeof document !== 'undefined') {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }
});

afterAll(() => {
  vi.restoreAllMocks();
});
