/** Proofshot the main cockpit chart's ARMED-ladder entry lines for ETH + HYPE. Run AFTER pnpm build. */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
try { process.loadEnvFile('.env.local'); } catch { /* */ }
const ADMIN_PIN = process.env.ADMIN_PIN; const DIR = 'proofshot-artifacts';
async function freePort(): Promise<number> { return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, () => { const a = s.address(); if (a && typeof a === 'object') s.close(() => res(a.port)); else s.close(() => rej(new Error('no port'))); }); s.on('error', rej); }); }
async function waitFor(url: string, ms: number): Promise<boolean> { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url, { redirect: 'manual' }); if (r.status > 0) return true; } catch { /* */ } await delay(500); } return false; }
async function main(): Promise<void> {
  if (!ADMIN_PIN) { console.log('SKIP no ADMIN_PIN'); process.exit(0); }
  const { chromium } = await import('@playwright/test');
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); } catch { browser = await chromium.launch({ headless: true }); }
  const port = await freePort(); const baseUrl = `http://127.0.0.1:${port}`; let server: ChildProcess | null = null; const notes: string[] = [];
  try {
    server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], { stdio: 'inherit', env: { ...process.env } });
    if (!(await waitFor(baseUrl, 60_000))) { console.log('FAIL server'); process.exit(1); }
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: ADMIN_PIN }) });
    const pair = (login.headers.get('set-cookie') ?? '').split(';')[0]; const eq = pair.indexOf('='); const cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: '127.0.0.1', path: '/' };
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await ctx.addCookies([cookie]); const page = await ctx.newPage();
    // The cockpit never reaches networkidle (ws + polls) — use domcontentloaded.
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByTestId('candle-chart-panel').waitFor({ state: 'visible', timeout: 20_000 }).catch(() => notes.push('no chart panel'));
    for (const coin of ['ETH', 'HYPE']) {
      const tab = page.getByTestId(`coin-tab-${coin}`);
      if (await tab.count()) { await tab.click(); } else if (coin !== 'ETH') { notes.push(`no ${coin} tab`); continue; }
      // candles fetch + the 8s armed-ladder poll + chart draw of the price lines.
      await delay(9_000);
      await page.getByTestId('candle-chart-panel').screenshot({ path: `${DIR}/armed-chart-${coin}.png` }).catch((e) => notes.push(`${coin} shot: ${String(e).slice(0, 60)}`));
      console.log(`  shot: armed-chart-${coin}.png`);
    }
    await ctx.close();
  } finally { await browser.close(); if (server && !server.killed) server.kill('SIGTERM'); }
  if (notes.length) console.log('NOTES: ' + notes.join(' | ')); console.log('DONE'); process.exit(0);
}
void main().catch((e) => { console.log(`FAIL ${String(e)}`); process.exit(1); });
