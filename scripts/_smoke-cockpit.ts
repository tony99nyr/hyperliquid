/**
 * CLIENT-SIDE browser smoke for /cockpit (catches uncaught React/client crashes
 * that `pnpm test` — jsdom unit tests — and `pnpm build` can miss).
 *
 *   Run: pnpm smoke
 *
 * What it does:
 *   1. Builds + starts the app on an ephemeral port (production server).
 *   2. POST /api/auth/login with ADMIN_PIN (from .env.local) to obtain the admin
 *      session cookie (the /cockpit RSC gate requires it).
 *   3. Loads /cockpit in headless Chrome with that cookie.
 *   4. FAILS if there is ANY uncaught page error (`pageerror`) or `console.error`
 *      — i.e. exactly the class of crash that shipped:
 *        "cannot add 'postgres_changes' callbacks … after subscribe()".
 *
 * This is the real-browser complement to tests/ui/realtime-resubscribe.test.tsx
 * (which reproduces the same crash class in jsdom via the enforcing mock). Run it
 * before pushing whenever a browser is available.
 *
 * Requires: a Chrome/Chromium (Playwright `channel: 'chrome'`, falling back to
 * the bundled chromium). If neither is installed, this prints SKIP and exits 0
 * so it never blocks environments without a browser — the jsdom mount test is the
 * always-on guard; this is the belt-and-suspenders real-browser pass.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

try {
  process.loadEnvFile('.env.local');
} catch {
  // env may already be in the shell (CI)
}

const ADMIN_PIN = process.env.ADMIN_PIN;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('could not allocate port')));
      }
    });
    srv.on('error', reject);
  });
}

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl, { redirect: 'manual' });
      // Any HTTP response (even a redirect/401) means the server is up.
      if (res.status > 0) return true;
    } catch {
      // not up yet
    }
    await delay(500);
  }
  return false;
}

async function main(): Promise<void> {
  if (!ADMIN_PIN) {
    console.log('SKIP  ADMIN_PIN not set (need it to authenticate /cockpit) — set it in .env.local');
    process.exit(0);
  }

  // Resolve a launchable browser; SKIP (not FAIL) if none is installed.
  let chromium: typeof import('@playwright/test').chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    console.log('SKIP  @playwright/test not installed — run `pnpm add -D @playwright/test`');
    process.exit(0);
  }

  const launchOpts: { headless: boolean; channel?: string } = { headless: true, channel: 'chrome' };
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      console.log(
        `SKIP  no Chrome/Chromium available for Playwright (${String(err).split('\n')[0]}). ` +
          'Install via `pnpm exec playwright install chromium` where a browser is supported.',
      );
      process.exit(0);
    }
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`=== Cockpit browser smoke (${baseUrl}/cockpit) ===`);

  // Build, then start the production server.
  console.log('Building (pnpm build)…');
  const build = spawn('pnpm', ['build'], { stdio: 'inherit' });
  const buildCode: number = await new Promise((res) => build.on('exit', (c) => res(c ?? 1)));
  if (buildCode !== 0) {
    console.log('FAIL  build failed');
    await browser.close();
    process.exit(1);
  }

  let server: ChildProcess | null = null;
  const errors: string[] = [];
  try {
    console.log(`Starting server on :${port}…`);
    server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], {
      stdio: 'inherit',
      env: { ...process.env },
    });

    const up = await waitForServer(baseUrl, 60_000);
    if (!up) {
      console.log('FAIL  server did not come up within 60s');
      process.exit(1);
    }

    // Authenticate to get the admin cookie, then attach it to the browser context.
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: ADMIN_PIN }),
    });
    if (!loginRes.ok) {
      console.log(`FAIL  /api/auth/login returned ${loginRes.status} (check ADMIN_PIN)`);
      process.exit(1);
    }
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const cookiePair = setCookie.split(';')[0]; // name=value
    const eq = cookiePair.indexOf('=');
    if (eq < 0) {
      console.log('FAIL  login did not return a session cookie');
      process.exit(1);
    }
    const cookieName = cookiePair.slice(0, eq);
    const cookieValue = cookiePair.slice(eq + 1);

    const context = await browser.newContext();
    await context.addCookies([
      { name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' },
    ]);
    const page = await context.newPage();

    // Capture the crash classes we care about.
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Network resource 404s (e.g. a missing favicon) are logged by the browser
      // as console errors but are NOT client-code crashes — the thing this smoke
      // guards. Real uncaught JS errors arrive via `pageerror`; React's own error
      // logging arrives as a console.error with a stack/message we DO want.
      if (/Failed to load resource/i.test(text)) return;
      errors.push(`console.error: ${text}`);
    });

    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    // Give realtime hooks time to subscribe AND for any session re-bind (the
    // production trigger for the crash) to fire its effects.
    await delay(4_000);

    // Sanity: the cockpit chrome must be present (proves we passed the PIN gate
    // and the client tree rendered rather than white-screening on a crash).
    const heading = await page.locator('text=HL Cockpit').count();
    if (heading === 0) {
      errors.push('render: "HL Cockpit" heading not found (page may have crashed/white-screened)');
    }

    await context.close();
  } finally {
    await browser.close();
    if (server && !server.killed) server.kill('SIGTERM');
  }

  if (errors.length > 0) {
    console.log(`\nFAIL  ${errors.length} client-side error(s) on /cockpit:`);
    for (const e of errors) console.log(`  - ${e}`);
    process.exit(1);
  }
  console.log('\nPASS  /cockpit loaded with NO uncaught page errors or console.error');
  process.exit(0);
}

void main().catch((err) => {
  console.log(`FAIL  smoke harness threw: ${String(err)}`);
  process.exit(1);
});
