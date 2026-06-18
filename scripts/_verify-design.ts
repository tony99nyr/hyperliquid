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

/**
 * Seed a MULTI-DAY history by inserting BACKDATED fills directly (paperFill
 * stamps Date.now(), so it can't backdate). Each round-trip closes on a distinct
 * day so the equity curve has a real rising shape spanning days + a readable axis
 * (Fix 1: close-time bucketing). Leaves one open position for an OPEN row.
 */
async function seedMultiDayHistory(coin: string): Promise<string> {
  const s = await openSession({ mode: 'paper', title: `DESIGN ${coin} multiday`, leaderAddress: null });
  seededSessions.push(s.id);
  const c = getServiceRoleClient();
  const mark = await fetchMark(coin);
  const sz = Math.max(0.001, Math.round((150 / mark) * 1000) / 1000);
  const DAY = 86_400_000;
  const now = Date.now();

  // Insert BACKDATED fills directly so `filled_at` is explicit (buildFillRow
  // omits it → DB defaults to now(); paperFill also stamps Date.now()). The
  // performance summary reads the fills ledger, so this gives a real multi-day
  // close-time-bucketed equity curve (Fix 1).
  async function insertFill(side: 'buy' | 'sell', px: number, daysAgo: number, reduceOnly = false): Promise<void> {
    const { error } = await c.from('fills').insert({
      session_id: s.id,
      client_intent_id: randomUUID(),
      coin: coin.toUpperCase(),
      side,
      px,
      sz,
      notional_usd: px * sz,
      fee_usd: px * sz * 0.0004,
      reduce_only: reduceOnly,
      partial: false,
      source: 'paper',
      hl_order_id: null,
      hl_raw: null,
      filled_at: new Date(now - daysAgo * DAY).toISOString(),
    });
    if (error) throw new Error(`seed insertFill failed: ${error.message}`);
  }

  // A run of round-trips, each opened+closed on its own day, stepping the
  // realized equity up over ~3 weeks (so the curve clearly rises across days).
  const legs: { open: number; close: number; openDays: number; closeDays: number }[] = [
    { open: mark * 0.94, close: mark * 0.96, openDays: 24, closeDays: 22 },
    { open: mark * 0.95, close: mark * 0.98, openDays: 20, closeDays: 18 },
    { open: mark * 0.97, close: mark * 0.995, openDays: 16, closeDays: 14 },
    { open: mark * 0.99, close: mark * 0.985, openDays: 12, closeDays: 10 }, // one small loss
    { open: mark * 0.985, close: mark * 1.01, openDays: 8, closeDays: 6 },
    { open: mark * 1.0, close: mark * 1.03, openDays: 4, closeDays: 2 },
  ];
  for (const leg of legs) {
    await insertFill('buy', leg.open, leg.openDays);
    await insertFill('sell', leg.close, leg.closeDays, true);
  }
  // Leave one open position TODAY so OPEN exposure + an OPEN ledger row show, AND
  // upsert the positions/pnl rows so the cockpit Open-Positions panel renders it
  // (that panel reads the positions table, not the fills ledger).
  const openPx = mark * 1.0;
  const openFill = await executeIntent({ clientIntentId: randomUUID(), sessionId: s.id, coin, side: 'buy', sz, reduceOnly: false, leverage: 5, createdAt: now });
  if (openFill.sz > 0) {
    await writePnlSnapshot({ sessionId: s.id, coin, realizedPnlUsd: 0, unrealizedPnlUsd: openPx * 0.004 * sz, feesPaidUsd: openFill.feeUsd, markPx: openFill.px * 1.004 });
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

    // 22 — Performance view, with a MULTI-DAY equity curve (Fix 1: rising shape +
    // readable axis from close-time bucketing).
    console.log('Seeding multi-day history session (performance + equity curve)…');
    await seedMultiDayHistory('ETH');
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await delay(4000);
    await page.locator('[data-testid="nav-performance"]').dispatchEvent('click');
    await page.locator('[data-testid="performance-view"]').waitFor({ state: 'visible', timeout: 8000 });
    await delay(2500);
    const kpis = await page.locator('[data-testid="kpi-card"]').count();
    const ledgerRows = await page.locator('[data-testid="ledger-row"]').count();
    const pfText = await page.locator('[data-kpi="profit-factor"]').textContent().catch(() => null);
    console.log(`  performance kpis=${kpis} ledgerRows=${ledgerRows} profitFactor=${pfText}`);
    await page.screenshot({ path: `${SHOT_DIR}/design-22-performance.png`, fullPage: false });

    // 03 — Approval modal (re-skinned).
    console.log('Seeding pending entry (approval modal)…');
    await seedPendingEntry('ETH', leaderAddress, 12);
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.locator('[data-testid="approval-popup"]').waitFor({ state: 'visible', timeout: 12_000 });
    await delay(800);
    await page.screenshot({ path: `${SHOT_DIR}/design-03-approval.png`, fullPage: false });

    // 11/12/13 — Mobile surfaces (402px): Cockpit (focal Open-Positions cards) +
    // the bottom tab bar, then the Traders and Performance tabs (Fix 2).
    console.log('Capturing mobile cockpit + tab bar…');
    const mobile = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2 });
    await mobile.addCookies([{ name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' }]);
    const mpage = await mobile.newPage();
    // Seed a session that has BOTH an open position (mobile cockpit focal panel)
    // AND closed multi-day history (mobile Performance tab cards + equity curve).
    // It must be the most-recent active session so getActiveSession resolves it,
    // so we seed a leader-followed open position first, THEN backfill its history.
    await seedMultiDayHistory('ETH');
    await mpage.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await delay(5000);
    const tabBar = await mpage.locator('[data-testid="mobile-tab-bar"]').isVisible().catch(() => false);
    const mobileOpenCount = await mpage.locator('[data-testid="open-count"]').textContent().catch(() => null);
    // Where does the focal Open-Positions panel sit relative to the chart? (Fix 2
    // promotes it directly under the chart.)
    const chartBox = await mpage.locator('[data-testid="candle-chart-panel"]').boundingBox().catch(() => null);
    const opBox = await mpage.locator('[data-testid="open-positions-panel"]').boundingBox().catch(() => null);
    const healthBox = await mpage.locator('[data-testid="health-panel"]').boundingBox().catch(() => null);
    console.log(`  mobile tab-bar visible=${tabBar} open-count=${mobileOpenCount}`);
    console.log(`  mobile y-order chart=${chartBox?.y?.toFixed(0)} openPositions=${opBox?.y?.toFixed(0)} health=${healthBox?.y?.toFixed(0)}`);
    await mpage.screenshot({ path: `${SHOT_DIR}/design-11-mobile-cockpit.png`, fullPage: false });
    // Focal panel close-up (scrolled into view) so we can SEE the position cards.
    const opPanel = mpage.locator('[data-testid="open-positions-panel"]');
    if (await opPanel.count()) {
      await opPanel.scrollIntoViewIfNeeded();
      await delay(800);
      await mpage.screenshot({ path: `${SHOT_DIR}/design-11b-mobile-open-positions.png`, fullPage: false });
    }

    // Traders tab.
    await mpage.locator('[data-testid="mobile-tab-traders"]').dispatchEvent('click');
    await mpage.locator('[data-testid="mobile-traders-view"]').waitFor({ state: 'visible', timeout: 8000 });
    await delay(1500);
    const traderRows = await mpage.locator('[data-testid="top-trader-row"]').count();
    console.log(`  mobile Traders tab rows=${traderRows}`);
    await mpage.screenshot({ path: `${SHOT_DIR}/design-12-mobile-traders.png`, fullPage: false });

    // Performance tab.
    await mpage.locator('[data-testid="mobile-tab-performance"]').dispatchEvent('click');
    await mpage.locator('[data-testid="performance-view"]').waitFor({ state: 'visible', timeout: 8000 });
    await delay(2000);
    const mobileCards = await mpage.locator('[data-testid="ledger-card"]').count();
    console.log(`  mobile Performance tab ledger-cards=${mobileCards}`);
    await mpage.screenshot({ path: `${SHOT_DIR}/design-13-mobile-performance.png`, fullPage: false });
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
