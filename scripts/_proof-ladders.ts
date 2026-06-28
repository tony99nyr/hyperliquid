/**
 * Driven proofshots for the Armed Ladders surface (P1d-1). After `pnpm build`:
 * start prod server, login (ADMIN_PIN), then capture (desktop + mobile):
 *   1. the Ladders tab (list / empty state + "New Ladder")
 *   2. the LadderBuilderModal with a populated rung → live risk preview
 *
 *   Run AFTER pnpm build:
 *     pnpm exec tsx --tsconfig tsconfig.scripts.json scripts/_proof-ladders.ts
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
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
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

    async function capture(width: number, height: number, isMobile: boolean, suffix: string, doArm: boolean): Promise<void> {
      const ctx = await browser.newContext({ viewport: { width, height }, isMobile });
      await ctx.addCookies([cookie]);
      const page = await ctx.newPage();
      await page.goto(`${baseUrl}/cockpit?tab=ladders`, { waitUntil: 'networkidle', timeout: 30_000 });
      await delay(2_500);
      await page.getByTestId('ladders-view').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => notes.push(`${suffix}: no ladders-view`));
      await page.screenshot({ path: `${DIR}/ladders-tab-${suffix}.png` });
      console.log(`  shot: ladders-tab-${suffix}.png`);

      // Open the builder + populate a rung so the live preview renders.
      const newBtn = page.getByTestId('ladder-new').first();
      if (await newBtn.count()) {
        await newBtn.click();
        await page.getByTestId('ladder-builder-modal').waitFor({ state: 'visible', timeout: 10_000 });
        await page.getByTestId('ladder-title').fill('ETH breakout pyramid');
        await page.getByTestId('rung-trigger-0').fill('2000');
        await delay(800);
        await page.screenshot({ path: `${DIR}/ladder-builder-${suffix}.png` });
        console.log(`  shot: ladder-builder-${suffix}.png`);

        if (doArm) {
          // Drive the full PAPER create+arm, then capture the armed row in the list.
          await page.getByTestId('ladder-arm').click();
          await page.waitForFunction(() => !document.querySelector('[data-testid="ladder-builder-modal"]'), { timeout: 15_000 }).catch(() => notes.push(`${suffix}: arm modal did not close`));
          await delay(2_000); // list reload
          await page.locator('[data-testid^="ladder-status-"]').first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => notes.push(`${suffix}: no armed row`));
          await page.screenshot({ path: `${DIR}/ladders-armed-${suffix}.png` });
          console.log(`  shot: ladders-armed-${suffix}.png`);
        } else {
          await page.getByTestId('ladder-close').click();
        }
      } else notes.push(`${suffix}: no ladder-new button`);
      await ctx.close();
    }

    await capture(1440, 900, false, 'desktop', true); // desktop arms a paper ladder
    await capture(390, 844, true, 'mobile', false); // mobile shows it in the list + the builder
  } finally {
    await browser.close();
    if (server && !server.killed) server.kill('SIGTERM');
  }
  if (notes.length) console.log('NOTES: ' + notes.join(' | '));
  console.log('DONE');
  process.exit(0);
}
void main().catch((e) => { console.log(`FAIL ${String(e)}`); process.exit(1); });
