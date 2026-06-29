/** Proofshot the cockpit with the ArmedLaddersPanel. Run AFTER pnpm build. */
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
    await page.goto(`${baseUrl}/cockpit`, { waitUntil: 'domcontentloaded', timeout: 30_000 }); await delay(6_000);
    const has = await page.getByTestId('armed-ladders-panel').count();
    notes.push(`armed-ladders-panel present: ${has > 0}`);
    await page.getByTestId('armed-ladders-panel').first().scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: `${DIR}/cockpit-armed-ladders.png` });
    console.log('  shot: cockpit-armed-ladders.png');
    await ctx.close();
  } finally { await browser.close(); if (server && !server.killed) server.kill('SIGTERM'); }
  console.log('NOTES: ' + notes.join(' | ')); console.log('DONE'); process.exit(0);
}
void main().catch((e) => { console.log(`FAIL ${String(e)}`); process.exit(1); });
