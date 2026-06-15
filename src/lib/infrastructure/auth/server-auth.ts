/**
 * Server-component auth helper. Reads the admin cookie via next/headers and
 * verifies it against the PIN / ADMIN_SECRET (vendored auth helpers). Used by the
 * RSC /cockpit gate — the request-object path in auth.ts is for route handlers.
 */

import { cookies } from 'next/headers';
import { verifyPin, verifyAdminSecret, ADMIN_AUTH_COOKIE_CONFIG } from './auth';

/** True when the current request carries a valid admin cookie. */
export async function isAdminAuthenticated(): Promise<boolean> {
  const store = await cookies();
  const token = store.get(ADMIN_AUTH_COOKIE_CONFIG.name)?.value;
  if (!token) return false;
  return verifyAdminSecret(token) || verifyPin(token);
}
