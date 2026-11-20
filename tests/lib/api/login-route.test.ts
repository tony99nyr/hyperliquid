/**
 * Pins the login route roles: the admin PIN mints an admin session, VIEWER_PIN
 * mints a viewer session, and a wrong PIN gets 401. A viewer cookie never passes
 * verifyAdminAuth.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/login/route';
import { verifyAdminAuth, getRequestAuthRole, ADMIN_AUTH_COOKIE_CONFIG } from '@/lib/infrastructure/auth/auth';
import { clearRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';

const saved = process.env.VIEWER_PIN;
let ip = 0;
let currentIp = '';

beforeEach(() => {
  process.env.VIEWER_PIN = 'viewer-test-pin';
  currentIp = `10.0.0.${++ip}`;
});
afterEach(() => {
  clearRateLimit(`login:${currentIp}`);
  if (saved === undefined) delete process.env.VIEWER_PIN;
  else process.env.VIEWER_PIN = saved;
});

const login = (pin: string) =>
  POST(new NextRequest('https://cockpit.test/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': currentIp },
    body: JSON.stringify({ pin }),
  }));

const cookieRequest = (res: Response) => {
  const token = /admin_auth=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  return new NextRequest('https://cockpit.test/api/x', { headers: { cookie: `${ADMIN_AUTH_COOKIE_CONFIG.name}=${token}` } });
};

describe('POST /api/auth/login roles', () => {
  it('the admin PIN mints an admin session', async () => {
    const res = await login(process.env.ADMIN_PIN ?? '');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: 'admin' });
    expect(await verifyAdminAuth(cookieRequest(res))).toBe(true);
  });

  it('the viewer PIN mints a viewer session that is not admin', async () => {
    const res = await login('viewer-test-pin');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: 'viewer' });
    const req = cookieRequest(res);
    expect(await verifyAdminAuth(req)).toBe(false);
    expect(await getRequestAuthRole(req)).toBe('viewer');
  });

  it('the viewer PIN is refused when VIEWER_PIN is unset', async () => {
    delete process.env.VIEWER_PIN;
    expect((await login('viewer-test-pin')).status).toBe(401);
  });

  it('a VIEWER_PIN equal to ADMIN_PIN still logs in as admin', async () => {
    process.env.VIEWER_PIN = process.env.ADMIN_PIN;
    const res = await login(process.env.ADMIN_PIN ?? '');
    expect(await res.json()).toEqual({ ok: true, role: 'admin' });
  });

  it('a viewer login does not reset the throttle on wrong guesses', async () => {
    // Alternate a wrong guess with a good viewer login. The throttle must still trip.
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await login(i % 2 === 0 ? `wrong-${i}` : 'viewer-test-pin')).status);
    expect(statuses).toContain(429);
  });

  it('a wrong PIN gets 401', async () => {
    expect((await login('wrong')).status).toBe(401);
  });
});
