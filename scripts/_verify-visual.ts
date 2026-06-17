/**
 * VISUAL verification harness (temporary, run-on-demand — NOT part of validate).
 *
 *   pnpm tsx --tsconfig tsconfig.scripts.json scripts/_verify-visual.ts
 *
 * Builds + starts the app, authenticates, then seeds temp cockpit data through
 * the SERVICE-ROLE path and screenshots three states, CLEANING UP after each:
 *   (a) Trader-detail drawer open (live positions stubbed via the rated dataset).
 *   (b) HealthPanel "MARKET READ / ENTRY" — a FLAT active session (no position).
 *   (c) HealthPanel "TRADE HEALTH" + PnlHero ROE — a session with an OPEN paper
 *       position whose leverage was persisted via the REAL write path
 *       (executeIntent --leverage), then a mark snapshot so uPnL + ROE render.
 *
 * Cleanup deletes every seeded session (ON DELETE CASCADE removes child rows) and
 * asserts none remain. Screenshots → docs/screenshots/.
 */

try {
  process.loadEnvFile('.env.local');
} catch {
  /* env may already be present */
}

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { mkdir } from 'node:fs/promises';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { openSession, closeSession } from '@/lib/cockpit/session-service';
import { executeIntent } from '@/lib/trading/fill-source';
import { writePnlSnapshot } from '@/lib/cockpit/fill-persistence-service';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { randomUUID } from 'node:crypto';

const SHOT_DIR = 'docs/screenshots';
const seededSessions: string[] = [];

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') srv.close(() => resolve(addr.port));
      else srv.close(() => reject(new Error('no port')));
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

async function fetchMark(coin: string): Promise<number> {
  const now = Date.now();
  const res = await fetchCandles(coin, '15m', now - 7 * 24 * 60 * 60 * 1000, now);
  const last = res.candles[res.candles.length - 1];
  if (!last || !(last.close > 0)) throw new Error(`no mark for ${coin}`);
  return last.close;
}

/** Seed a FLAT active session (no position) → Health renders MARKET READ / ENTRY. */
async function seedFlatSession(): Promise<string> {
  const s = await openSession({ mode: 'paper', title: 'VERIFY flat (entry read)', leaderAddress: null });
  seededSessions.push(s.id);
  return s.id;
}

/**
 * Seed a session with an OPEN paper position via the REAL write path
 * (executeIntent carries leverage → persisted onto positions.leverage), then
 * write a mark snapshot so uPnL + ROE render in PnlHero.
 */
async function seedPositionSession(coin: string, leverage: number): Promise<string> {
  const s = await openSession({ mode: 'paper', title: `VERIFY ${coin} ${leverage}x (trade health + ROE)`, leaderAddress: null });
  seededSessions.push(s.id);
  const mark = await fetchMark(coin);
  // Risk-based small size; execute as a market buy through the paper book-match.
  const entry = mark;
  const sz = Math.max(0.001, Math.round((50 / entry) * 1000) / 1000);
  const fill = await executeIntent({
    clientIntentId: randomUUID(),
    sessionId: s.id,
    coin,
    side: 'buy',
    sz,
    reduceOnly: false,
    leverage,
    createdAt: Date.now(),
  });
  if (fill.sz <= 0) throw new Error('seed position: nothing filled (book empty?)');
  // Mark slightly above entry so uPnL is positive + ROE is visibly magnified.
  const markPx = fill.px * 1.01;
  const uPnl = (markPx - fill.px) * fill.sz;
  await writePnlSnapshot({
    sessionId: s.id,
    coin,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: uPnl,
    feesPaidUsd: fill.feeUsd,
    markPx,
  });
  return s.id;
}

async function cleanup(): Promise<void> {
  const c = getServiceRoleClient();
  for (const id of seededSessions) {
    try {
      await closeSession(id);
    } catch {
      /* ignore */
    }
    const { error } = await c.from('sessions').delete().eq('id', id);
    if (error) console.log(`  WARN delete ${id}: ${error.message}`);
  }
  // Assert none remain.
  const { data } = await c.from('sessions').select('id').in('id', seededSessions);
  const remaining = data?.length ?? 0;
  console.log(remaining === 0 ? '  cleanup OK — no seeded sessions remain' : `  WARN ${remaining} seeded sessions remain`);
}

async function main(): Promise<void> {
  const ADMIN_PIN = process.env.ADMIN_PIN;
  if (!ADMIN_PIN) {
    console.log('SKIP  ADMIN_PIN not set');
    process.exit(0);
  }
  let chromium: typeof import('@playwright/test').chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    console.log('SKIP  @playwright/test not installed');
    process.exit(0);
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  } catch {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      console.log(`SKIP  no browser (${String(err).split('\n')[0]})`);
      process.exit(0);
    }
  }

  await mkdir(SHOT_DIR, { recursive: true });
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log('Building…');
  const build = spawn('pnpm', ['build'], { stdio: 'inherit' });
  const code: number = await new Promise((r) => build.on('exit', (c) => r(c ?? 1)));
  if (code !== 0) {
    await browser.close();
    console.log('FAIL build');
    process.exit(1);
  }

  let server: ChildProcess | null = null;
  try {
    server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], { stdio: 'inherit', env: { ...process.env } });
    if (!(await waitForServer(baseUrl, 60_000))) throw new Error('server not up');

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

    const context = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
    await context.addCookies([{ name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();

    // (b) MARKET READ / ENTRY — flat session.
    console.log('Seeding FLAT session (market read / entry)…');
    await seedFlatSession();
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await delay(4000);
    const flatMode = await page.locator('[data-testid="health-panel"]').getAttribute('data-mode');
    console.log(`  health-panel data-mode = ${flatMode} (expect market-read)`);
    await page.screenshot({ path: `${SHOT_DIR}/verify-b-market-read-entry.png`, fullPage: false });

    // (a) Trader-detail drawer — click the first top-trader row.
    console.log('Opening trader-detail drawer…');
    await page.locator('[data-testid="top-trader-row"]').first().click();
    await page.locator('[data-testid="trader-detail-drawer"]').waitFor({ state: 'visible', timeout: 8000 });
    await delay(2500); // let live positions resolve
    await page.screenshot({ path: `${SHOT_DIR}/verify-a-trader-detail.png`, fullPage: false });
    await page.locator('[data-testid="trader-detail-close"]').click();

    // (c) TRADE HEALTH + ROE — open-position session via the real write path.
    console.log('Seeding OPEN-position session (trade health + ROE)…');
    await seedPositionSession('ETH', 5);
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await delay(5000); // realtime + pnl snapshot propagation
    const posMode = await page.locator('[data-testid="health-panel"]').getAttribute('data-mode');
    const roe = await page.locator('[data-testid="pnl-hero-roe"]').textContent().catch(() => null);
    console.log(`  health-panel data-mode = ${posMode} (expect trade-health)`);
    console.log(`  PnlHero ROE = ${roe ?? '(not shown)'}`);
    await page.screenshot({ path: `${SHOT_DIR}/verify-c-trade-health-roe.png`, fullPage: false });
    // Tight crop of the PnlHero so the REAL ROE (uPnl/margin) is legible.
    const hero = page.locator('[data-testid="pnl-hero"]');
    if (await hero.count()) {
      await hero.screenshot({ path: `${SHOT_DIR}/verify-c2-pnlhero-roe.png` });
    }

    await context.close();
  } finally {
    console.log('Cleaning up seeded sessions…');
    await cleanup();
    await browser.close();
    if (server && !server.killed) server.kill('SIGTERM');
  }
  console.log('\nDONE — screenshots in docs/screenshots/. Review them for the visual verdict.');
  process.exit(0);
}

void main().catch(async (err) => {
  console.log(`FAIL  ${String(err)}`);
  try {
    await cleanup();
  } catch {
    /* best effort */
  }
  process.exit(1);
});
