/**
 * Admin-PIN login route. Verifies the submitted PIN (or ADMIN_SECRET) via the
 * vendored auth helpers, then sets an OPAQUE session-token cookie (never the raw
 * PIN/secret) so the RSC /cockpit gate passes on the next request. Brute force is
 * throttled per client IP. Server-only — never exposes the secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  verifyPin,
  verifyAdminSecret,
  issueSessionToken,
  getClientIdentifier,
  ADMIN_AUTH_COOKIE_CONFIG,
} from '@/lib/infrastructure/auth/auth';
import { checkRateLimit, clearRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Throttle brute force BEFORE doing any verification work.
  const clientKey = `login:${getClientIdentifier(request)}`;
  const limit = checkRateLimit(clientKey);
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Too many attempts — try again later.' },
      { status: 429 },
    );
  }

  let pin = '';
  try {
    const body = (await request.json()) as { pin?: unknown };
    pin = typeof body.pin === 'string' ? body.pin : '';
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }

  if (!pin) {
    return NextResponse.json({ ok: false, error: 'PIN required' }, { status: 400 });
  }

  if (!verifyPin(pin) && !verifyAdminSecret(pin)) {
    return NextResponse.json({ ok: false, error: 'Invalid PIN' }, { status: 401 });
  }

  // Success: reset the throttle for this client and mint an opaque session token.
  clearRateLimit(clientKey);
  const sessionToken = issueSessionToken(ADMIN_AUTH_COOKIE_CONFIG.maxAge);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_AUTH_COOKIE_CONFIG.name, sessionToken, {
    maxAge: ADMIN_AUTH_COOKIE_CONFIG.maxAge,
    httpOnly: ADMIN_AUTH_COOKIE_CONFIG.httpOnly,
    secure: ADMIN_AUTH_COOKIE_CONFIG.secure,
    sameSite: ADMIN_AUTH_COOKIE_CONFIG.sameSite,
    path: ADMIN_AUTH_COOKIE_CONFIG.path,
  });
  return res;
}
