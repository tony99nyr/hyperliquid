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
import { createPendingAction } from '@/lib/cockpit/pending-actions-service';
import { writePnlSnapshot } from '@/lib/cockpit/fill-persistence-service';
import { fetchCandles } from '@/lib/hyperliquid/candle-service';
import { getTopTraders } from '@/lib/hyperliquid/top-traders-service';
import type { PendingActionProposal } from '@/types/cockpit';
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

/**
 * Seed a session that FOLLOWS a leader AND holds an open position on the coin →
 * the co-located Position+Health top zone (Item 1) + Leader-vs-You (Item 4)
 * render. The position goes in via the REAL write path (executeIntent).
 */
async function seedLeaderPositionSession(coin: string, leaderAddress: string): Promise<string> {
  const s = await openSession({ mode: 'paper', title: `VERIFY ${coin} + leader (co-located + L-vs-You)`, leaderAddress });
  seededSessions.push(s.id);
  const mark = await fetchMark(coin);
  const sz = Math.max(0.001, Math.round((50 / mark) * 1000) / 1000);
  const fill = await executeIntent({
    clientIntentId: randomUUID(),
    sessionId: s.id,
    coin,
    side: 'buy',
    sz,
    reduceOnly: false,
    leverage: 5,
    createdAt: Date.now(),
  });
  if (fill.sz <= 0) throw new Error('seed leader position: nothing filled');
  const markPx = fill.px * 1.012;
  await writePnlSnapshot({
    sessionId: s.id,
    coin,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: (markPx - fill.px) * fill.sz,
    feesPaidUsd: fill.feeUsd,
    markPx,
  });
  return s.id;
}

/**
 * Seed a FLAT session with a PENDING entry action so the redesigned ApprovalPopup
 * renders (Item 2 + 3). The proposal carries the leverage / coin-max / leader
 * fields the popup's slider + Match-leader presets read. A 5% stop @ a coin max
 * of 20 lets the harness drag the slider to trigger the liq-inside-stop warning.
 */
async function seedPendingEntry(
  coin: string,
  mode: 'paper' | 'live',
  leaderAddress: string,
  leaderLeverage: number,
): Promise<string> {
  const s = await openSession({ mode, title: `VERIFY ${mode} approval (${coin})`, leaderAddress });
  seededSessions.push(s.id);
  const entry = await fetchMark(coin);
  const sz = Math.max(0.001, Math.round((100 / entry) * 1000) / 1000);
  // 6% stop: at the 20× coin max the liq (~5% adverse, i.e. ABOVE/closer than the
  // 6% stop for a long) falls INSIDE the stop, so dragging the slider to max
  // visibly trips the liquidation-inside-stop guard. At the 5× default it is safe.
  const stopPx = Math.round(entry * 0.94 * 100) / 100;
  const proposal: PendingActionProposal = {
    intent: {
      clientIntentId: randomUUID(),
      sessionId: s.id,
      coin,
      side: 'buy',
      sz,
      reduceOnly: false,
      leverage: 5,
      createdAt: Date.now(),
    },
    display: {
      coin,
      side: 'buy',
      sz,
      estPx: entry,
      stopPx,
      rationale: `Long the ${coin} breakout — risk-sized entry; leverage is your call.`,
      leverage: 5,
      coinMaxLeverage: 20,
      leaderLeverage,
      leaderAddress,
    },
  };
  await createPendingAction({ sessionId: s.id, kind: 'entry', mode, proposal });
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

    // Pick a real rated leader to follow (so the leader side has live data).
    const leaderAddress = getTopTraders(1)[0]?.address ?? '0x0000000000000000000000000000000000000001';

    // (d) CO-LOCATED Position + Health top zone (Item 1) + Leader-vs-You (Item 4).
    console.log('Seeding leader-followed OPEN-position session (co-located + Leader-vs-You)…');
    await seedLeaderPositionSession('ETH', leaderAddress);
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await delay(5000);
    const lvy = await page.locator('[data-testid="leader-vs-you"]').getAttribute('data-alignment').catch(() => null);
    console.log(`  leader-vs-you alignment = ${lvy ?? '(not shown)'}`);
    await page.screenshot({ path: `${SHOT_DIR}/verify-d-colocated-position-health.png`, fullPage: false });
    const lvyPanel = page.locator('[data-testid="leader-vs-you"]');
    if (await lvyPanel.count()) await lvyPanel.screenshot({ path: `${SHOT_DIR}/verify-d2-leader-vs-you.png` });

    // (e1) Redesigned ApprovalPopup — PAPER (one-tap) with the leverage slider.
    console.log('Seeding PAPER pending entry (approval card + leverage)…');
    await seedPendingEntry('ETH', 'paper', leaderAddress, 20);
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.locator('[data-testid="approval-popup"]').waitFor({ state: 'visible', timeout: 12_000 });
    await delay(800);
    await page.screenshot({ path: `${SHOT_DIR}/verify-e1-approval-paper.png`, fullPage: false });
    // Drag the slider to the coin max → trigger the liquidation-inside-stop guard.
    const slider = page.locator('[data-testid="leverage-slider"]');
    if (await slider.count()) {
      await slider.fill('20');
      await delay(400);
      const warn = await page.locator('[data-testid="liq-inside-stop-warning"]').count();
      console.log(`  liq-inside-stop warning visible at 20x: ${warn > 0}`);
      await page.locator('[data-testid="approval-popup"]').screenshot({ path: `${SHOT_DIR}/verify-e2-approval-leverage-warning.png` });
    }

    // (e3) Redesigned ApprovalPopup — LIVE (typed-phrase gate) variant.
    console.log('Seeding LIVE pending entry (typed-phrase gate)…');
    await seedPendingEntry('ETH', 'live', leaderAddress, 20);
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.locator('[data-testid="approval-popup"]').waitFor({ state: 'visible', timeout: 12_000 });
    await delay(800);
    const liveBadge = await page.locator('[data-testid="mode-badge"]').textContent().catch(() => null);
    console.log(`  approval mode badge = ${liveBadge ?? '(none)'} (expect LIVE)`);
    await page.locator('[data-testid="approval-popup"]').screenshot({ path: `${SHOT_DIR}/verify-e3-approval-live.png` });

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
