/**
 * Server-component auth helper. Reads the session cookie via next/headers and
 * verifies it against the PIN / ADMIN_SECRET (vendored auth helpers). Used by the
 * RSC /cockpit gate — the request-object path in auth.ts is for route handlers.
 */

import { cookies } from 'next/headers';
import { roleForCookieToken, ADMIN_AUTH_COOKIE_CONFIG, type AuthRole } from './auth';

async function readSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(ADMIN_AUTH_COOKIE_CONFIG.name)?.value;
}

/** The page-gate role: admin, viewer (read-only), or null (show the PIN gate). */
export async function getPageAuthRole(): Promise<AuthRole | null> {
  return roleForCookieToken(await readSessionCookie());
}
