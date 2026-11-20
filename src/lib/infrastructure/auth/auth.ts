/**
 * Admin-PIN authentication (vendored from iamrossi, Redis-session paths stripped).
 *
 * iamrossi validated cookie tokens against a Redis session store with a PIN /
 * ADMIN_SECRET fallback. This repo has no Redis in Phase 0, so the cookie /
 * Bearer paths verify directly against ADMIN_SECRET (or the admin PIN). The
 * constant-time comparison + the pure PIN/secret helpers are unchanged.
 *
 * STUBBED vs source: removed `await import('../storage/kv')` Redis session
 * lookups in verifyAuthToken / verifyAdminAuth. Re-add a Supabase-backed
 * session check in Phase 1 if durable server sessions are needed.
 */

import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { logError } from '../logging/logger';

const COOKIE_NAME = 'cockpit_auth';
const ADMIN_COOKIE_NAME = 'admin_auth';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

/** Creates a secure authentication token. */
export function createAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Hashes a PIN for secure comparison. */
export function hashPin(pin: string): string {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

/**
 * STATELESS signed session token (Vercel multi-instance safe — no shared store).
 *
 * On a successful PIN/secret login we mint `<nonce>.<expiryMs>.<hmac>` where the
 * HMAC is keyed on ADMIN_SECRET. Any instance can verify it (same secret) and
 * the raw PIN/secret never becomes the cookie value — a cookie leak discloses
 * neither the credential nor a forgeable token (an attacker can't compute the
 * HMAC without ADMIN_SECRET). Expiry is enforced in-band. This replaces the
 * earlier in-memory Map, which only verified on the instance that minted it.
 */
function sessionSigningKey(): string {
  // Bind the signature to ADMIN_SECRET (always set in any real deploy). If it is
  // missing, signing/verification fail closed (verifyAdminSecret already errors).
  return process.env.ADMIN_SECRET ?? '';
}

function signSessionPayload(payload: string): string {
  return crypto.createHmac('sha256', sessionSigningKey()).update(payload).digest('hex');
}

/** Mint a stateless session token valid for `maxAgeSec`. */
export function issueSessionToken(maxAgeSec: number = COOKIE_MAX_AGE): string {
  const nonce = createAuthToken();
  const expiry = Date.now() + maxAgeSec * 1000;
  const payload = `${nonce}.${expiry}`;
  return `${payload}.${signSessionPayload(payload)}`;
}

/** True when `token` is a well-formed, unexpired, correctly-signed session token. */
export function verifySessionToken(token: string): boolean {
  if (!token || !sessionSigningKey()) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [nonce, expiryStr, sig] = parts;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() >= expiry) return false;
  // Constant-time HMAC comparison (and the comparison also rejects a tampered
  // expiry/nonce, since either changes the signature).
  return constantTimeEquals(sig ?? '', signSessionPayload(`${nonce}.${expiryStr}`));
}

/** Constant-time string comparison that is also length-safe. */
function constantTimeEquals(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, 'utf8');
    const bBuf = Buffer.from(b, 'utf8');
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

/**
 * Constant-time check of a request's `Authorization: Bearer <token>` against an
 * expected secret. Length-safe (no throw on a length mismatch). Used by the
 * auto-exit detector/cron, which present a dedicated token rather than the admin
 * credential. Returns false when the secret is unset or the header is absent/bad.
 */
export function verifyCronBearer(request: NextRequest, secret: string | undefined): boolean {
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  return constantTimeEquals(m[1], secret);
}

/**
 * Verifies the PIN against ADMIN_PIN using constant-time comparison
 * (prevents timing attacks).
 */
export function verifyPin(pin: string): boolean {
  const correctPin = process.env.ADMIN_PIN;
  if (!correctPin) {
    logError('ADMIN_PIN environment variable is not set');
    return false;
  }
  return constantTimeEquals(pin, correctPin);
}

/** Verifies the admin secret from ADMIN_SECRET using constant-time comparison. */
export function verifyAdminSecret(secret: string): boolean {
  const correctSecret = process.env.ADMIN_SECRET;
  if (!correctSecret) {
    logError('ADMIN_SECRET environment variable is not set');
    return false;
  }
  return constantTimeEquals(secret, correctSecret);
}

/** Gets admin secret from environment (server-side only). */
export function getAdminSecret(): string {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    throw new Error('ADMIN_SECRET environment variable not configured');
  }
  return secret;
}

/** Gets client IP address from request (for rate limiting). */
export function getClientIdentifier(request: NextRequest): string {
  // Prefer the platform-set `x-real-ip` (Vercel sets this to the true client IP
  // at the edge; it is not client-appendable). Only fall back to the left-most
  // `x-forwarded-for` hop when x-real-ip is absent — that token IS client-
  // spoofable, so trusting the platform header first hardens the rate-limit key
  // against an authed caller rotating XFF to evade their per-client cap.
  const realIp = request.headers.get('x-real-ip');
  const forwarded = request.headers.get('x-forwarded-for');
  const rawIp = realIp ?? (forwarded ? forwarded.split(',')[0] : null);
  return rawIp?.trim() || 'unknown';
}

/** True when a session-cookie value grants ADMIN (session token or legacy raw credential). */
function isAdminCookieToken(token: string | undefined): boolean {
  // Cookie carries an opaque session token (preferred). Fall back to direct
  // PIN/secret match for backward-compat with any pre-existing cookie.
  return !!token && (verifySessionToken(token) || verifyAdminSecret(token) || verifyPin(token));
}

/** Reads the session cookie value from a route-handler request. */
function readSessionCookie(request: NextRequest): string | undefined {
  const cookieHeader = request.headers.get('cookie') || '';
  const adminCookie = cookieHeader
    .split(';')
    .find((c) => c.trim().startsWith(`${ADMIN_COOKIE_NAME}=`));
  return adminCookie?.split('=')[1]?.trim() || undefined;
}

/**
 * Verifies ADMIN authentication from request (cookie or Authorization header).
 * Accepts ADMIN_SECRET or the admin PIN via Bearer token or cookie.
 * A viewer session NEVER passes this check. Every mutating route uses it.
 */
export async function verifyAdminAuth(request: NextRequest): Promise<boolean> {
  if (isAdminCookieToken(readSessionCookie(request))) return true;

  // Bearer path
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return false;
  return verifyAdminSecret(token) || verifyPin(token);
}

// ---------------------------------------------------------------------------
// Read-only viewer role. A separate VIEWER_PIN mints a viewer session token.
// The viewer token has a different shape and a different signed payload, so
// verifySessionToken (admin) always rejects it.
// ---------------------------------------------------------------------------

export type AuthRole = 'admin' | 'viewer';

const VIEWER_TOKEN_PREFIX = 'viewer';

/**
 * PURE: the usable viewer PIN, or null when viewer access is off. Viewer access
 * is off when the PIN is unset or blank, or when it equals the admin PIN or the
 * admin secret (a shared credential must never downgrade to read-only).
 */
export function resolveViewerPin(
  viewerPin: string | undefined,
  adminPin: string | undefined,
  adminSecret: string | undefined,
): string | null {
  if (!viewerPin || viewerPin.trim() === '') return null;
  if (adminPin && constantTimeEquals(viewerPin, adminPin)) return null;
  if (adminSecret && constantTimeEquals(viewerPin, adminSecret)) return null;
  return viewerPin;
}

function configuredViewerPin(): string | null {
  return resolveViewerPin(process.env.VIEWER_PIN, process.env.ADMIN_PIN, process.env.ADMIN_SECRET);
}

/** Constant-time check of a submitted PIN against VIEWER_PIN. False when viewer access is off. */
export function verifyViewerPin(pin: string): boolean {
  const viewerPin = configuredViewerPin();
  if (!viewerPin || !pin) return false;
  return constantTimeEquals(pin, viewerPin);
}

/**
 * The signed payload binds the hash of the current VIEWER_PIN. A rotated or
 * removed VIEWER_PIN therefore invalidates every viewer session at once.
 */
function viewerSignedPayload(nonce: string, expiry: string, viewerPin: string): string {
  return `${VIEWER_TOKEN_PREFIX}.${nonce}.${expiry}.${hashPin(viewerPin)}`;
}

/** Mint a viewer session token, or null when viewer access is off. */
export function issueViewerSessionToken(maxAgeSec: number = COOKIE_MAX_AGE): string | null {
  const viewerPin = configuredViewerPin();
  if (!viewerPin || !sessionSigningKey()) return null;
  const nonce = createAuthToken();
  const expiry = String(Date.now() + maxAgeSec * 1000);
  const sig = signSessionPayload(viewerSignedPayload(nonce, expiry, viewerPin));
  return `${VIEWER_TOKEN_PREFIX}.${nonce}.${expiry}.${sig}`;
}

/** True when `token` is an unexpired viewer token signed for the CURRENT VIEWER_PIN. */
export function verifyViewerSessionToken(token: string | undefined): boolean {
  const viewerPin = configuredViewerPin();
  if (!token || !viewerPin || !sessionSigningKey()) return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VIEWER_TOKEN_PREFIX) return false;
  const [, nonce, expiryStr, sig] = parts;
  const expiry = Number(expiryStr);
  if (!nonce || !Number.isFinite(expiry) || Date.now() >= expiry) return false;
  return constantTimeEquals(sig ?? '', signSessionPayload(viewerSignedPayload(nonce, expiryStr, viewerPin)));
}

/** The role a session-cookie value grants, or null. Admin wins over viewer. */
export function roleForCookieToken(token: string | undefined): AuthRole | null {
  if (isAdminCookieToken(token)) return 'admin';
  if (verifyViewerSessionToken(token)) return 'viewer';
  return null;
}

/** The caller's role (admin or viewer), or null when unauthenticated. */
export async function getRequestAuthRole(request: NextRequest): Promise<AuthRole | null> {
  if (await verifyAdminAuth(request)) return 'admin';
  return verifyViewerSessionToken(readSessionCookie(request)) ? 'viewer' : null;
}

/**
 * READ-ONLY check: true for an admin OR a viewer. Use it ONLY in GET handlers
 * that the cockpit page reads. Never use it in a mutating handler; the
 * deny-by-default test (tests/lib/api/viewer-deny-by-default.test.ts) fails if
 * a non-GET handler references it.
 */
export async function verifyReadAuth(request: NextRequest): Promise<boolean> {
  return (await getRequestAuthRole(request)) !== null;
}

/** Cookie configuration for cockpit (PIN) authentication. */
export const AUTH_COOKIE_CONFIG = {
  name: COOKIE_NAME,
  maxAge: COOKIE_MAX_AGE,
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

/** Cookie configuration for admin authentication. */
export const ADMIN_AUTH_COOKIE_CONFIG = {
  name: ADMIN_COOKIE_NAME,
  maxAge: COOKIE_MAX_AGE,
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};
