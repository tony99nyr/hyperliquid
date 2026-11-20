import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  resolveViewerPin,
  verifyViewerPin,
  issueViewerSessionToken,
  verifyViewerSessionToken,
  issueSessionToken,
  verifySessionToken,
  verifyAdminAuth,
  verifyReadAuth,
  VIEWER_READS_PER_MIN,
  getRequestAuthRole,
  roleForCookieToken,
  ADMIN_AUTH_COOKIE_CONFIG,
} from '@/lib/infrastructure/auth/auth';

const VIEWER = 'viewer-test-pin';
const withCookie = (token: string) =>
  new NextRequest('https://cockpit.test/api/x', { headers: { cookie: `${ADMIN_AUTH_COOKIE_CONFIG.name}=${token}` } });

const saved = process.env.VIEWER_PIN;
beforeEach(() => {
  process.env.VIEWER_PIN = VIEWER;
});
afterEach(() => {
  if (saved === undefined) delete process.env.VIEWER_PIN;
  else process.env.VIEWER_PIN = saved;
});

describe('resolveViewerPin (pure)', () => {
  it('returns the PIN when it is distinct from the admin credentials', () => {
    expect(resolveViewerPin('v', 'a', 's')).toBe('v');
  });
  it('is off when unset or blank', () => {
    expect(resolveViewerPin(undefined, 'a', 's')).toBeNull();
    expect(resolveViewerPin('', 'a', 's')).toBeNull();
    expect(resolveViewerPin('   ', 'a', 's')).toBeNull();
  });
  it('is off when it equals the admin PIN or the admin secret', () => {
    expect(resolveViewerPin('a', 'a', 's')).toBeNull();
    expect(resolveViewerPin('s', 'a', 's')).toBeNull();
  });
});

describe('verifyViewerPin', () => {
  it('accepts the viewer PIN and rejects others', () => {
    expect(verifyViewerPin(VIEWER)).toBe(true);
    expect(verifyViewerPin('nope')).toBe(false);
    expect(verifyViewerPin('')).toBe(false);
  });
});

describe('viewer session tokens', () => {
  it('a viewer token verifies as viewer and NEVER as admin', async () => {
    const token = issueViewerSessionToken(60) ?? '';
    expect(verifyViewerSessionToken(token)).toBe(true);
    expect(verifySessionToken(token)).toBe(false);
    expect(await verifyAdminAuth(withCookie(token))).toBe(false);
    expect(await verifyReadAuth(withCookie(token))).toBe(true);
    expect(await getRequestAuthRole(withCookie(token))).toBe('viewer');
    expect(roleForCookieToken(token)).toBe('viewer');
  });

  it('stripping the viewer prefix does not yield an admin token', async () => {
    const token = issueViewerSessionToken(60) ?? '';
    const stripped = token.split('.').slice(1).join('.');
    expect(verifySessionToken(stripped)).toBe(false);
    expect(await verifyAdminAuth(withCookie(stripped))).toBe(false);
  });

  it('an admin token is admin for both checks', async () => {
    const token = issueSessionToken(60);
    expect(verifyViewerSessionToken(token)).toBe(false);
    expect(await getRequestAuthRole(withCookie(token))).toBe('admin');
    expect(await verifyReadAuth(withCookie(token))).toBe(true);
  });

  it('rotating or removing VIEWER_PIN revokes existing viewer sessions', async () => {
    const token = issueViewerSessionToken(60) ?? '';
    process.env.VIEWER_PIN = 'rotated-pin';
    expect(verifyViewerSessionToken(token)).toBe(false);
    delete process.env.VIEWER_PIN;
    expect(verifyViewerSessionToken(token)).toBe(false);
    expect(await verifyReadAuth(withCookie(token))).toBe(false);
  });

  it('no token is issued when viewer access is off', () => {
    delete process.env.VIEWER_PIN;
    expect(issueViewerSessionToken(60)).toBeNull();
  });

  it('rejects expired, tampered and malformed tokens', () => {
    expect(verifyViewerSessionToken(issueViewerSessionToken(-1) ?? '')).toBe(false);
    const [p, n, , sig] = (issueViewerSessionToken(60) ?? '').split('.');
    expect(verifyViewerSessionToken(`${p}.${n}.${Date.now() + 9e9}.${sig}`)).toBe(false);
    expect(verifyViewerSessionToken('viewer.a.b')).toBe(false);
    expect(verifyViewerSessionToken(undefined)).toBe(false);
  });

  it('the raw admin PIN as a cookie or bearer grants nothing (the login route is the only PIN path)', async () => {
    const saved = process.env.ADMIN_PIN;
    process.env.ADMIN_PIN = '482913';
    try {
      expect(await verifyAdminAuth(withCookie('482913'))).toBe(false);
      const bearer = new NextRequest('https://cockpit.test/api/x', { headers: { authorization: 'Bearer 482913' } });
      expect(await verifyAdminAuth(bearer)).toBe(false);
      expect(await verifyReadAuth(bearer)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ADMIN_PIN;
      else process.env.ADMIN_PIN = saved;
    }
  });

  it('caps the read requests of one viewer client and leaves an admin uncapped', async () => {
    const viewer = issueViewerSessionToken(60) ?? '';
    const from = (token: string) => new NextRequest('https://cockpit.test/api/x', { headers: { cookie: `${ADMIN_AUTH_COOKIE_CONFIG.name}=${token}`, 'x-real-ip': '10.9.9.9' } });
    for (let i = 0; i < VIEWER_READS_PER_MIN; i++) expect(await verifyReadAuth(from(viewer))).toBe(true);
    expect(await verifyReadAuth(from(viewer))).toBe(false);
    expect(await verifyReadAuth(from(issueSessionToken(60)))).toBe(true);
  });

  it('the raw viewer PIN as a cookie or bearer grants nothing', async () => {
    expect(await verifyReadAuth(withCookie(VIEWER))).toBe(false);
    const bearer = new NextRequest('https://cockpit.test/api/x', { headers: { authorization: `Bearer ${VIEWER}` } });
    expect(await verifyReadAuth(bearer)).toBe(false);
  });
});
