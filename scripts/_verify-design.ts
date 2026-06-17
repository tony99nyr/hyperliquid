/**
 * DESIGN-ALIGNMENT visual verification (run-on-demand — NOT part of validate).
 *
 *   pnpm tsx --tsconfig tsconfig.scripts.json scripts/_verify-design.ts
 *
 * Builds + starts the app, authenticates, seeds temp cockpit data through the
 * REAL write path (executeIntent / createPendingAction), and screenshots the
 * design-handoff surfaces, CLEANING UP after each:
 *   01 Cockpit view WITH an open position (focal Open-Positions panel + health)
 *   03 Approval modal (re-skinned Confirm-Order)
 *   20 Exit modal (single-position close, slider + presets)
 *   21 Trader detail drawer
 *   22 Performance view (KPIs + equity + ledger)
 *   11 Mobile Cockpit (402px viewport)
 *
 * Cleanup deletes every seeded session (ON DELETE CASCADE) and asserts none
 * remain. Screenshots → docs/screenshots/design-*.png.
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
import { randomUUID } from 'node:crypto';
import { getServiceRoleClient } from '@/lib/cockpit/supabase-server';
import { openSession, closeSession } from '@/lib/cockpit/session-service';
import { executeIntent } from '@/lib/trading/fill-source';
import { createPendingAction } from '@/lib/cockpit/pending-actions-service';
import { writePnlSnapshot } from '@/lib/cockpit/fill-persistence-service';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { getTopTraders } from '@/lib/hyperliquid/top-traders-service';
import type { PendingActionProposal } from '@/types/cockpit';

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

/** Seed a session with an OPEN paper position (+ leader) so the focal panel renders. */
async function seedPositionSession(coin: string, leverage: number, leaderAddress: string | null): Promise<string> {
  const s = await openSession({ mode: 'paper', title: `DESIGN ${coin} ${leverage}x`, leaderAddress });
  seededSessions.push(s.id);
  const mark = await fetchMark(coin);
  const sz = Math.max(0.001, Math.round((200 / mark) * 1000) / 1000);
  const fill = await executeIntent({
    clientIntentId: randomUUID(),
    sessionId: s.id,
    coin,
    side: 'sell', // a SHORT so it ALIGNS with the typical bearish ETH read
    sz,
    reduceOnly: false,
    leverage,
    createdAt: Date.now(),
  });
  if (fill.sz <= 0) throw new Error('seed position: nothing filled');
  const markPx = fill.px * 0.997; // short in slight profit
  await writePnlSnapshot({
    sessionId: s.id,
    coin,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: (fill.px - markPx) * fill.sz,
    feesPaidUsd: fill.feeUsd,
    markPx,
  });
  return s.id;
}

/** Seed a closed-trade history so the Performance ledger + KPIs + equity render. */
async function seedHistorySession(coin: string): Promise<string> {
  const s = await openSession({ mode: 'paper', title: `DESIGN ${coin} history`, leaderAddress: null });
  seededSessions.push(s.id);
  const mark = await fetchMark(coin);
  const sz = Math.max(0.001, Math.round((150 / mark) * 1000) / 1000);
  // Round-trip 1: a winning long (buy then sell higher via a synthetic mark).
  const buy = await executeIntent({ clientIntentId: randomUUID(), sessionId: s.id, coin, side: 'buy', sz, reduceOnly: false, leverage: 5, createdAt: Date.now() - 3600_000 });
  if (buy.sz > 0) {
    await executeIntent({ clientIntentId: randomUUID(), sessionId: s.id, coin, side: 'sell', sz: buy.sz, reduceOnly: true, leverage: 5, createdAt: Date.now() - 1800_000 });
  }
  // Round-trip 2: a small loss (sell then buy back) — best-effort via the book.
  const sell = await executeIntent({ clientIntentId: randomUUID(), sessionId: s.id, coin, side: 'sell', sz, reduceOnly: false, leverage: 5, createdAt: Date.now() - 1200_000 });
  if (sell.sz > 0) {
    await executeIntent({ clientIntentId: randomUUID(), sessionId: s.id, coin, side: 'buy', sz: sell.sz, reduceOnly: true, leverage: 5, createdAt: Date.now() - 600_000 });
  }
  // Leave one open position so OPEN exposure + an OPEN ledger row show.
  const open = await executeIntent({ clientIntentId: randomUUID(), sessionId: s.id, coin, side: 'buy', sz, reduceOnly: false, leverage: 8, createdAt: Date.now() });
  if (open.sz > 0) {
    await writePnlSnapshot({ sessionId: s.id, coin, realizedPnlUsd: 0, unrealizedPnlUsd: open.px * 0.004 * open.sz, feesPaidUsd: open.feeUsd, markPx: open.px * 1.004 });
  }
  return s.id;
}

/** Seed a FLAT session with a PENDING entry so the re-skinned approval modal renders. */
async function seedPendingEntry(coin: string, leaderAddress: string, leaderLeverage: number): Promise<string> {
  const s = await openSession({ mode: 'paper', title: `DESIGN approval ${coin}`, leaderAddress });
  seededSessions.push(s.id);
  const entry = await fetchMark(coin);
  const sz = Math.max(0.001, Math.round((250 / entry) * 1000) / 1000);
  const stopPx = Math.round(entry * 0.96 * 100) / 100;
  const proposal: PendingActionProposal = {
    intent: { clientIntentId: randomUUID(), sessionId: s.id, coin, side: 'sell', sz, reduceOnly: false, leverage: 5, createdAt: Date.now() },
    display: {
      coin,
      side: 'sell',
      sz,
      estPx: entry,
      stopPx,
      rationale: `Short the ${coin} breakdown — multi-TF bias is bearish; leverage is your call.`,
      leverage: 5,
      coinMaxLeverage: 20,
      leaderLeverage,
      leaderAddress,
    },
  };
  await createPendingAction({ sessionId: s.id, kind: 'entry', mode: 'paper', proposal });
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

    const context = await browser.newContext({ viewport: { width: 1680, height: 980 } });
    await context.addCookies([{ name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();

    const leaderAddress = getTopTraders(1)[0]?.address ?? '0x0000000000000000000000000000000000000001';

    // 01 — Cockpit WITH an open position (focal panel + health).
    console.log('Seeding open-position session (focal panel)…');
    await seedPositionSession('ETH', 10, leaderAddress);
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await delay(5500);
    const openCount = await page.locator('[data-testid="open-count"]').textContent().catch(() => null);
    const aligned = await page.locator('[data-testid="alignment-badge"]').first().getAttribute('data-aligned').catch(() => null);
    console.log(`  open-count=${openCount} alignment-badge data-aligned=${aligned}`);
    await page.screenshot({ path: `${SHOT_DIR}/design-01-cockpit.png`, fullPage: false });

    // 20 — Exit modal (single-position close).
    const closeBtn = page.locator('[data-testid="position-close"]').first();
    if (await closeBtn.count()) {
      await closeBtn.scrollIntoViewIfNeeded();
      await closeBtn.dispatchEvent('click');
      await page.locator('[data-testid="exit-modal"]').waitFor({ state: 'visible', timeout: 8000 });
      await delay(500);
      const realized = await page.locator('[data-testid="exit-realized"]').textContent().catch(() => null);
      console.log(`  exit-modal realized PnL = ${realized}`);
      await page.screenshot({ path: `${SHOT_DIR}/design-20-exit.png`, fullPage: false });
      await page.locator('[data-testid="exit-cancel"]').dispatchEvent('click');
    } else {
      console.log('  WARN no position-close button (no open row)');
    }

    // 21 — Trader detail drawer.
    console.log('Opening trader drawer…');
    const row = page.locator('[data-testid="top-trader-row"]').first();
    if (await row.count()) {
      await row.scrollIntoViewIfNeeded();
      await row.dispatchEvent('click');
      await page.locator('[data-testid="trader-detail-drawer"]').waitFor({ state: 'visible', timeout: 8000 });
      await delay(2000);
      await page.screenshot({ path: `${SHOT_DIR}/design-21-trader.png`, fullPage: false });
      await page.locator('[data-testid="trader-detail-close"]').dispatchEvent('click').catch(() => {});
    }

    // 22 — Performance view.
    console.log('Seeding history session (performance)…');
    await seedHistorySession('ETH');
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await delay(4000);
    await page.locator('[data-testid="nav-performance"]').dispatchEvent('click');
    await page.locator('[data-testid="performance-view"]').waitFor({ state: 'visible', timeout: 8000 });
    await delay(2500);
    const kpis = await page.locator('[data-testid="kpi-card"]').count();
    const ledgerRows = await page.locator('[data-testid="ledger-row"]').count();
    console.log(`  performance kpis=${kpis} ledgerRows=${ledgerRows}`);
    await page.screenshot({ path: `${SHOT_DIR}/design-22-performance.png`, fullPage: false });

    // 03 — Approval modal (re-skinned).
    console.log('Seeding pending entry (approval modal)…');
    await seedPendingEntry('ETH', leaderAddress, 12);
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.locator('[data-testid="approval-popup"]').waitFor({ state: 'visible', timeout: 12_000 });
    await delay(800);
    await page.screenshot({ path: `${SHOT_DIR}/design-03-approval.png`, fullPage: false });

    // 11 — Mobile Cockpit (402px).
    console.log('Capturing mobile cockpit…');
    const mobile = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2 });
    await mobile.addCookies([{ name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' }]);
    const mpage = await mobile.newPage();
    await seedPositionSession('ETH', 5, leaderAddress);
    await mpage.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await delay(5000);
    await mpage.screenshot({ path: `${SHOT_DIR}/design-11-mobile-cockpit.png`, fullPage: false });
    await mobile.close();

    await context.close();
  } finally {
    console.log('Cleaning up seeded sessions…');
    await cleanup();
    await browser.close();
    if (server && !server.killed) server.kill('SIGTERM');
  }
  console.log('\nDONE — screenshots in docs/screenshots/design-*.png.');
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
