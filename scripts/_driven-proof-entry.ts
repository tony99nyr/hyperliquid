/**
 * DRIVEN production proof for the self-service "＋ New Position" entry path.
 *
 * After `pnpm build`: starts the prod server, logs in (ADMIN_PIN), opens /cockpit,
 * clicks "＋ New Position", fills the EntryModal (ETH SHORT, small risk, some
 * leverage), screenshots the modal, clicks Approve (PAPER one-tap), then asserts a
 * position appears in the Open Positions panel and screenshots the result.
 *
 *   Run AFTER pnpm build:
 *     pnpm exec tsx --tsconfig tsconfig.scripts.json scripts/_driven-proof-entry.ts
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
const SHOT_MODAL = 'proofshot-artifacts/entry-modal.png';
const SHOT_RESULT = 'proofshot-artifacts/entry-result-position.png';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const a = srv.address();
      if (a && typeof a === 'object') srv.close(() => resolve(a.port));
      else srv.close(() => reject(new Error('no port')));
    });
    srv.on('error', reject);
  });
}

async function waitForServer(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status > 0) return true;
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
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  } catch {
    browser = await chromium.launch({ headless: true });
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  const errors: string[] = [];

  try {
    server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], {
      stdio: 'inherit',
      env: { ...process.env },
    });
    if (!(await waitForServer(baseUrl, 60_000))) {
      console.log('FAIL  server did not start');
      process.exit(1);
    }

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: ADMIN_PIN }),
    });
    if (!login.ok) {
      console.log(`FAIL  login ${login.status}`);
      process.exit(1);
    }
    const pair = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const eq = pair.indexOf('=');
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies([
      { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: '127.0.0.1', path: '/' },
    ]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/Failed to load resource/i.test(m.text())) return;
      errors.push(`console.error: ${m.text()}`);
    });

    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'networkidle', timeout: 30_000 });
    await delay(6_000); // let the HL price feed land (sizing needs a mark)

    // 1) Open the entry modal via the "＋ New Position" button.
    const newBtn = page.getByTestId('new-position-button').first();
    const emptyBtn = page.getByTestId('empty-open-position').first();
    if (await newBtn.count()) await newBtn.click();
    else if (await emptyBtn.count()) await emptyBtn.click();
    else {
      console.log('FAIL  no New Position button found');
      process.exit(1);
    }

    const modal = page.getByTestId('entry-modal');
    await modal.waitFor({ state: 'visible', timeout: 10_000 });

    // 2) Fill: ETH short, small risk. (ETH is the default coin.)
    await page.getByTestId('entry-coin-ETH').click();
    await page.getByTestId('entry-side-short').click();
    const risk = page.getByTestId('entry-risk');
    await risk.fill('20');
    // Some leverage via the reused slider.
    const slider = page.getByTestId('leverage-slider');
    if (await slider.count()) {
      await slider.focus();
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight'); // bump leverage
    }
    await delay(500);

    const sizeText = await page.getByTestId('entry-size').innerText().catch(() => '');
    console.log(`  computed size: "${sizeText}"`);
    await page.screenshot({ path: SHOT_MODAL });
    console.log(`  screenshot: ${SHOT_MODAL}`);

    const approve = page.getByTestId('entry-approve');
    const disabled = await approve.isDisabled();
    if (disabled) {
      errors.push('entry Approve is disabled (paper one-tap should be enabled once sized)');
    } else {
      // 3) Approve (PAPER one-tap) → opens the position via the new route.
      await approve.click();
      // The modal closes on success; the position then renders via realtime.
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="entry-modal"]'),
        { timeout: 15_000 },
      ).catch(() => errors.push('entry modal did not close after Approve'));
      await delay(5_000); // let the realtime fill → positions render

      const rows = await page.getByTestId('position-row').count();
      console.log(`  open position rows after Approve: ${rows}`);
      if (rows === 0) {
        // Surface any inline error to aid debugging.
        const err = await page.getByTestId('entry-error').innerText().catch(() => '');
        errors.push(`no position row rendered after Approve${err ? ` (modal error: ${err})` : ''}`);
      }
      await page.screenshot({ path: SHOT_RESULT, fullPage: true });
      console.log(`  screenshot: ${SHOT_RESULT}`);
    }

    await ctx.close();
  } finally {
    await browser.close();
    if (server && !server.killed) server.kill('SIGTERM');
  }

  if (errors.length) {
    console.log(`\nFAIL  ${errors.length} issue(s):`);
    for (const e of errors) console.log(`  - ${e}`);
    process.exit(1);
  }
  console.log('\nPASS  New Position → fill → Approve → position opened + rendered, 0 errors');
  process.exit(0);
}

void main().catch((e) => {
  console.log(`FAIL  ${String(e)}`);
  process.exit(1);
});
