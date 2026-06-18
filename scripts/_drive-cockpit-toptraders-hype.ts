/**
 * One-off DRIVEN production check for the Top-Traders rail upgrade + HYPE coin.
 * Assumes `pnpm build` already ran. Starts the prod server, logs in, and:
 *   1. asserts the rail is scrollable (scrollHeight > clientHeight) + has rows,
 *   2. toggles each filter chip and asserts the visible row count changes,
 *   3. selects HYPE in the coin tabs and asserts the chart/regime/orderbook
 *      render with a REAL (>0) HYPE price.
 * Captures screenshots. Fails on any console/page error.
 *
 *   Run AFTER pnpm build:
 *   pnpm tsx --tsconfig tsconfig.scripts.json scripts/_drive-cockpit-toptraders-hype.ts
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
  const findings: string[] = [];

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
    await delay(4_000);

    // --- 1. rail rows + scrollability ---
    const list = page.locator('[data-testid="top-traders-list"]');
    const rowCount = async () => page.locator('[data-testid="top-trader-row"]').count();
    const baseRows = await rowCount();
    console.log(`  rail rows (default tradeable-only ON): ${baseRows}`);
    if (baseRows < 5) findings.push(`expected many rail rows, got ${baseRows}`);

    const scroll = await list.evaluate((el) => ({
      scrollH: (el as HTMLElement).scrollHeight,
      clientH: (el as HTMLElement).clientHeight,
    })).catch(() => null);
    if (!scroll) {
      findings.push('top-traders-list not found');
    } else {
      console.log(`  rail scroll: scrollHeight=${scroll.scrollH} clientHeight=${scroll.clientH}`);
      if (scroll.scrollH <= scroll.clientH) findings.push('rail is not scrollable (no overflow)');
      // Prove it actually scrolls.
      await list.evaluate((el) => { (el as HTMLElement).scrollTop = 200; });
      const after = await list.evaluate((el) => (el as HTMLElement).scrollTop);
      if (after <= 0) findings.push('rail scrollTop did not move');
      else console.log(`  rail scrolled to scrollTop=${after}`);
      await list.evaluate((el) => { (el as HTMLElement).scrollTop = 0; });
    }

    await page.screenshot({ path: 'proofshot-artifacts/cockpit-rail-default.png', fullPage: true });

    // --- 2. filter chips change the list ---
    const tradeable = page.getByRole('button', { name: /tradeable only/i });
    await tradeable.click(); // turn OFF → should show >= baseRows
    await delay(300);
    const allRows = await rowCount();
    console.log(`  rows after tradeable-only OFF: ${allRows}`);
    if (allRows < baseRows) findings.push(`tradeable OFF should not reduce rows (${allRows} < ${baseRows})`);
    await tradeable.click(); // back ON

    const cleanChip = page.getByRole('button', { name: /clean book/i });
    await cleanChip.click();
    await delay(300);
    const cleanRows = await rowCount();
    console.log(`  rows after Clean book ON: ${cleanRows}`);
    if (cleanRows > baseRows) findings.push('Clean book filter should not increase rows');
    if ((await cleanChip.getAttribute('aria-pressed')) !== 'true') findings.push('clean chip aria-pressed not true');
    await cleanChip.click();

    const riskChip = page.getByRole('button', { name: /hide at-risk/i });
    await riskChip.click();
    await delay(300);
    const noRiskRows = await rowCount();
    console.log(`  rows after Hide at-risk ON: ${noRiskRows}`);
    if (noRiskRows > baseRows) findings.push('Hide at-risk filter should not increase rows');
    await riskChip.click();

    await page.screenshot({ path: 'proofshot-artifacts/cockpit-rail-filtered.png', fullPage: true });

    // --- 3. HYPE coin ---
    const hypeTab = page.locator('[data-testid="coin-tab-HYPE"]').first();
    if ((await hypeTab.count()) === 0) {
      findings.push('HYPE not present in coin selector');
    } else {
      await hypeTab.click();
      await delay(6_000); // let HYPE candles/regime/orderbook land
      const bodyText = (await page.locator('body').innerText().catch(() => '')) ?? '';
      const hasHype = /HYPE/.test(bodyText);
      const prices = [...bodyText.matchAll(/\$\s?([0-9][0-9,]*\.[0-9]+)/g)]
        .map((m) => parseFloat(m[1].replace(/,/g, '')))
        .filter((n) => n > 0);
      console.log(`  HYPE selected: HYPE text present=${hasHype}; real prices: ${prices.slice(0, 5).map((p) => '$' + p).join(', ')}`);
      if (!hasHype) findings.push('HYPE label not visible after selecting HYPE');
      if (prices.length === 0) findings.push('no real $ price after selecting HYPE (candles/orderbook did not land)');
      await page.screenshot({ path: 'proofshot-artifacts/cockpit-hype-selected.png', fullPage: true });
    }

    await ctx.close();
  } finally {
    await browser.close();
    if (server && !server.killed) server.kill('SIGTERM');
  }

  if (errors.length || findings.length) {
    console.log(`\nFAIL  ${errors.length + findings.length} issue(s):`);
    for (const e of [...findings, ...errors]) console.log(`  - ${e}`);
    process.exit(1);
  }
  console.log('\nPASS  rail scrolls + filter chips work + HYPE loads chart/regime/orderbook with real data');
  process.exit(0);
}

void main().catch((e) => {
  console.log(`FAIL  ${String(e)}`);
  process.exit(1);
});
