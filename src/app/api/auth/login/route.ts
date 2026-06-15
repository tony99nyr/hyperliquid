/**
 * Admin-PIN login route. Verifies the submitted PIN (or ADMIN_SECRET) via the
 * vendored auth helpers and sets the admin cookie so the RSC /cockpit gate
 * passes on the next request. Server-only — never exposes the secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  verifyPin,
  verifyAdminSecret,
  ADMIN_AUTH_COOKIE_CONFIG,
} from '@/lib/infrastructure/auth/auth';

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_AUTH_COOKIE_CONFIG.name, pin, {
    maxAge: ADMIN_AUTH_COOKIE_CONFIG.maxAge,
    httpOnly: ADMIN_AUTH_COOKIE_CONFIG.httpOnly,
    secure: ADMIN_AUTH_COOKIE_CONFIG.secure,
    sameSite: ADMIN_AUTH_COOKIE_CONFIG.sameSite,
    path: ADMIN_AUTH_COOKIE_CONFIG.path,
  });
  return res;
}
