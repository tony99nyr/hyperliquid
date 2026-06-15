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
 * Verifies the PIN against ADMIN_PIN using constant-time comparison
 * (prevents timing attacks).
 */
export function verifyPin(pin: string): boolean {
  const correctPin = process.env.ADMIN_PIN ?? process.env.WORKOUT_ADMIN_PIN;
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
  const forwarded = request.headers.get('x-forwarded-for');
  const rawIp = forwarded ? forwarded.split(',')[0] : request.headers.get('x-real-ip');
  return rawIp?.trim() || 'unknown';
}

/**
 * Verifies admin authentication from request (cookie or Authorization header).
 * Phase 0: accepts ADMIN_SECRET or the admin PIN via Bearer token or cookie.
 */
export async function verifyAdminAuth(request: NextRequest): Promise<boolean> {
  // Cookie path
  const cookieHeader = request.headers.get('cookie') || '';
  const adminCookie = cookieHeader
    .split(';')
    .find((c) => c.trim().startsWith(`${ADMIN_COOKIE_NAME}=`));
  if (adminCookie) {
    const token = adminCookie.split('=')[1]?.trim();
    if (token && (verifyAdminSecret(token) || verifyPin(token))) return true;
  }

  // Bearer path
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return false;
  return verifyAdminSecret(token) || verifyPin(token);
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
