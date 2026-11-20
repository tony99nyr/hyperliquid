/**
 * Server-component auth helper. Reads the session cookie via next/headers and
 * verifies it against the PIN / ADMIN_SECRET (vendored auth helpers). Used by the
 * RSC /cockpit gate — the request-object path in auth.ts is for route handlers.
 */

import { cookies, headers } from 'next/headers';
import { roleForCookieToken, ADMIN_AUTH_COOKIE_CONFIG, type AuthRole } from './auth';
import { checkRateLimit } from '../rate-limiting/in-memory-rate-limit';

/** Page loads per minute for one viewer client. Each load reads Supabase and Hyperliquid. */
export const VIEWER_PAGE_LOADS_PER_MIN = 30;

/**
 * The page-gate role: admin, viewer (read-only), or null (show the PIN gate).
 * A viewer over the page-load cap gets null for the rest of the window, so a reload
 * loop cannot spend the deployment's Hyperliquid and Supabase budget.
 */
export async function getPageAuthRole(): Promise<AuthRole | null> {
  const store = await cookies();
  const role = roleForCookieToken(store.get(ADMIN_AUTH_COOKIE_CONFIG.name)?.value);
  if (role !== 'viewer') return role;
  const h = await headers();
  // Same precedence as getClientIdentifier: the platform header first.
  const client = (h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0])?.trim() || 'unknown';
  return checkRateLimit(`viewer-page:${client}`, VIEWER_PAGE_LOADS_PER_MIN, 60_000).allowed ? role : null;
}
