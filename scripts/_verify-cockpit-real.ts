/**
 * REAL-BROWSER cockpit verification against the LIVE active session (NO seeding).
 *
 *   Run: pnpm exec tsx --tsconfig tsconfig.scripts.json scripts/_verify-cockpit-real.ts
 *
 * Builds (optional — set SKIP_BUILD=1 to reuse .next), starts the production
 * server, logs in with ADMIN_PIN, loads /cockpit in real Chromium bound to the
 * real active session, then screenshots desktop + mobile and asserts the real
 * open position renders. Captures console.error + any 429 network responses.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* env may already be present */
}

const ADMIN_PIN = process.env.ADMIN_PIN;
const OUT = '/tmp/hl-verify';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('no port')));
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
      if (res.status > 0) return true;
    } catch {
      /* not up */
    }
    await delay(500);
  }
  return false;
}

async function main(): Promise<void> {
  if (!ADMIN_PIN) {
    console.log('SKIP  ADMIN_PIN not set');
    process.exit(0);
  }
  const { chromium } = await import('@playwright/test');
  const fs = await import('node:fs');
  fs.mkdirSync(OUT, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  } catch {
    browser = await chromium.launch({ headless: true });
  }

  if (!process.env.SKIP_BUILD) {
    console.log('Building…');
    const build = spawn('pnpm', ['build'], { stdio: 'inherit' });
    const code: number = await new Promise((r) => build.on('exit', (c) => r(c ?? 1)));
    if (code !== 0) {
      console.log('FAIL build');
      await browser.close();
      process.exit(1);
    }
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  const consoleErrors: string[] = [];
  const status429: string[] = [];
  const hlDirectCalls: string[] = [];

  try {
    server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], {
      stdio: 'ignore',
      env: { ...process.env },
    });
    if (!(await waitForServer(baseUrl, 60_000))) {
      console.log('FAIL server did not start');
      process.exit(1);
    }

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: ADMIN_PIN }),
    });
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const pair = setCookie.split(';')[0];
    const eq = pair.indexOf('=');
    const cookieName = pair.slice(0, eq);
    const cookieValue = pair.slice(eq + 1);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) {
        consoleErrors.push(m.text());
      }
    });
    page.on('response', (res) => {
      if (res.status() === 429) status429.push(res.url());
      if (/api\.hyperliquid\.xyz/.test(res.url())) hlDirectCalls.push(`${res.status()} ${res.url()}`);
    });

    console.log('Loading /cockpit (desktop)…');
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 45_000 });
    await delay(8_000); // let realtime + candle + regime + book populate

    await page.screenshot({ path: `${OUT}/desktop-cockpit.png`, fullPage: false });
    // Focused capture of the focal Open-Positions panel for parity inspection.
    const opp = page.locator('[data-testid="open-positions-panel"]');
    if (await opp.count()) await opp.screenshot({ path: `${OUT}/desktop-open-positions.png` });
    const oppBoxD = await opp.boundingBox().catch(() => null);
    const rowBoxD = await page.locator('[data-testid="position-row"]').first().boundingBox().catch(() => null);
    console.log('DESKTOP open-positions box:', JSON.stringify(oppBoxD), 'row box:', JSON.stringify(rowBoxD));
    const upnl = await page.locator('[data-testid="position-upnl"]').first().innerText().catch(() => '(none)');
    const sideBadge = await page.locator('[data-testid="position-side"]').first().innerText().catch(() => '(none)');
    const equityTop = await page.locator('[data-testid="cockpit-topbar"]').innerText().catch(() => '');
    console.log(`POSITION: row side badge = "${sideBadge}", uPnL cell = "${upnl}"`);
    console.log(`TOPBAR equity text: ${equityTop.replace(/\n/g, ' | ')}`);

    // Switch to Performance view.
    const perfNav = page.locator('[data-testid="nav-performance"]');
    if (await perfNav.count()) {
      await perfNav.click();
      await delay(1_500);
      await page.screenshot({ path: `${OUT}/desktop-performance.png`, fullPage: false });
      const perfVisible = await page.locator('[data-testid="performance-view"]').count();
      console.log(`PERF-SWITCH: performance-view present after click = ${perfVisible > 0}`);
      // back
      await page.locator('[data-testid="nav-cockpit"]').click();
      await delay(1_000);
    } else {
      console.log('PERF-SWITCH: nav-performance NOT FOUND');
    }

    // Assertions on the real position render.
    const bodyText = (await page.locator('body').innerText()) ?? '';
    const has0Open = /0\s*open/i.test(bodyText);
    const hasShortBadge = /short/i.test(bodyText);
    const hasEntry = bodyText.includes('1736') || bodyText.includes('1,736');
    console.log(`POSITION: "0 open" present = ${has0Open}`);
    console.log(`POSITION: "short" text present = ${hasShortBadge}`);
    console.log(`POSITION: entry 1736.9 present = ${hasEntry}`);

    // Feed/chart/regime status text scan.
    console.log(`STATUS: "connecting" present = ${/connecting/i.test(bodyText)}`);
    console.log(`STATUS: "reading" present = ${/reading/i.test(bodyText)}`);
    console.log(`STATUS: "feed idle" present = ${/feed idle/i.test(bodyText)}`);
    console.log(`STATUS: "feed live" present = ${/feed live/i.test(bodyText)}`);

    // Mobile pass.
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    await mctx.addCookies([{ name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' }]);
    const mpage = await mctx.newPage();
    await mpage.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 45_000 });
    await delay(6_000);
    await mpage.screenshot({ path: `${OUT}/mobile-cockpit.png`, fullPage: true });
    // Dump mobile layout diagnostics.
    const oppBox = await mpage.locator('[data-testid="open-positions-panel"]').boundingBox().catch(() => null);
    const chartBox = await mpage.locator('[data-testid="candle-chart-panel"]').boundingBox().catch(() => null);
    const canvasBox = await mpage.locator('[data-testid="candle-chart"]').boundingBox().catch(() => null);
    console.log('MOBILE open-positions box:', JSON.stringify(oppBox));
    console.log('MOBILE chart-panel box:', JSON.stringify(chartBox));
    console.log('MOBILE chart-canvas box:', JSON.stringify(canvasBox));
    await mctx.close();
    await context.close();
  } finally {
    await browser.close();
    if (server && !server.killed) server.kill('SIGTERM');
  }

  console.log('\n=== console.error count:', consoleErrors.length);
  for (const e of consoleErrors.slice(0, 20)) console.log('  ERR:', e.slice(0, 300));
  console.log('=== 429 responses:', status429.length);
  for (const u of status429.slice(0, 10)) console.log('  429:', u);
  console.log('=== direct api.hyperliquid.xyz calls from browser:', hlDirectCalls.length);
  for (const u of hlDirectCalls.slice(0, 10)) console.log('  HL:', u);
  console.log(`\nScreenshots in ${OUT}/`);
}

void main().catch((e) => {
  console.log('FAIL harness threw:', String(e));
  process.exit(1);
});
