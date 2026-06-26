/**
 * Driven proofshots for the position-setup + insights UI. After `pnpm build`:
 * start prod server, login (ADMIN_PIN), then capture (desktop + mobile):
 *   1. the EntryModal (hold-timeframe selector + ATR stop hint + liq cushion)
 *   2. a paper position opened, with the row's "insights ›" + "held"
 *   3. the PositionInsightsModal (run chart + health + ATR protective stop)
 *
 *   Run AFTER pnpm build:
 *     pnpm exec tsx --tsconfig tsconfig.scripts.json scripts/_proof-position-ux.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

try { process.loadEnvFile('.env.local'); } catch { /* env may be present */ }
const ADMIN_PIN = process.env.ADMIN_PIN;
const DIR = 'proofshot-artifacts';

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, () => { const a = s.address(); if (a && typeof a === 'object') s.close(() => res(a.port)); else s.close(() => rej(new Error('no port'))); });
    s.on('error', rej);
  });
}
async function waitForServer(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url, { redirect: 'manual' }); if (r.status > 0) return true; } catch { /* down */ } await delay(500); }
  return false;
}

async function main(): Promise<void> {
  if (!ADMIN_PIN) { console.log('SKIP  ADMIN_PIN not set'); process.exit(0); }
  const { chromium } = await import('@playwright/test');
  let browser;
  try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
  catch { browser = await chromium.launch({ headless: true }); }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  const notes: string[] = [];
  try {
    server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], { stdio: 'inherit', env: { ...process.env } });
    if (!(await waitForServer(baseUrl, 60_000))) { console.log('FAIL  server did not start'); process.exit(1); }

    const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: ADMIN_PIN }) });
    if (!login.ok) { console.log(`FAIL  login ${login.status}`); process.exit(1); }
    const pair = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const eq = pair.indexOf('=');
    const cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: '127.0.0.1', path: '/' };

    // ---- DESKTOP ----
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies([cookie]);
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await delay(6_000); // price feed

    // Entry modal with the new TF/ATR/cushion UI.
    const newBtn = page.getByTestId('new-position-button').first();
    const emptyBtn = page.getByTestId('empty-open-position').first();
    if (await newBtn.count()) await newBtn.click(); else if (await emptyBtn.count()) await emptyBtn.click();
    await page.getByTestId('entry-modal').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('entry-side-short').click();
    await page.getByTestId('entry-tf-position').click(); // show the position-TF ATR stop
    await page.getByTestId('entry-risk').fill('20');
    await delay(1500); // ATR candles + seed
    await page.screenshot({ path: `${DIR}/entry-modal-new.png` });
    console.log(`  shot: entry-modal-new.png`);

    // Approve a paper position, then open its insights.
    const approve = page.getByTestId('entry-approve');
    if (await approve.isDisabled()) { notes.push('entry approve disabled'); }
    else {
      await approve.click();
      await page.waitForFunction(() => !document.querySelector('[data-testid="entry-modal"]'), { timeout: 15_000 }).catch(() => notes.push('entry modal did not close'));
      await delay(5_000);
      await page.screenshot({ path: `${DIR}/cockpit-with-position.png` });
      console.log(`  shot: cockpit-with-position.png`);
      const insightsBtn = page.getByTestId('position-open-insights').first();
      if (await insightsBtn.count()) {
        await insightsBtn.click();
        await page.getByTestId('position-insights-modal').waitFor({ state: 'visible', timeout: 10_000 });
        await delay(2500); // chart + ATR
        await page.screenshot({ path: `${DIR}/position-insights-desktop.png` });
        console.log(`  shot: position-insights-desktop.png`);
      } else notes.push('no position row to open insights');
    }
    await ctx.close();

    // ---- MOBILE ----
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    await mctx.addCookies([cookie]);
    const mp = await mctx.newPage();
    await mp.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await delay(5_000);
    const mInsights = mp.getByTestId('position-open-insights').first();
    if (await mInsights.count()) {
      await mInsights.click();
      await mp.getByTestId('position-insights-modal').waitFor({ state: 'visible', timeout: 10_000 });
      await delay(2500);
      await mp.screenshot({ path: `${DIR}/position-insights-mobile.png` });
      console.log(`  shot: position-insights-mobile.png`);
    } else notes.push('mobile: no position row');
    await mctx.close();
  } finally {
    await browser.close();
    if (server && !server.killed) server.kill('SIGTERM');
  }
  if (notes.length) console.log('NOTES: ' + notes.join(' | '));
  console.log('DONE');
  process.exit(0);
}
void main().catch((e) => { console.log(`FAIL ${String(e)}`); process.exit(1); });
