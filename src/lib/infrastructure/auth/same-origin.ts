/**
 * Same-origin (CSRF) defense-in-depth for mutating POST routes.
 *
 * The cockpit's executing/decision routes (approve / reject / safe-exit) ride an
 * admin cookie. A cookie is sent automatically on cross-site requests, so a
 * malicious page could forge a state-changing POST (CSRF). We reject any request
 * whose Origin (or, lacking that, Referer host) does not match the request's own
 * host. This is layered ON TOP of admin auth — not a replacement for it.
 *
 * Pragmatics: same-origin browser POSTs send a matching `Origin`; server-side /
 * test callers typically send NEITHER `Origin` nor `Referer`, so we ALLOW when
 * both are absent (a CSRF attack from a browser always carries an Origin). This
 * keeps the test harness and any server-to-server caller working while still
 * blocking the browser cross-site forgery we actually care about.
 */

import type { NextRequest } from 'next/server';

/** Extract a comparable host from an absolute URL string (null if unparseable). */
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * True when the request is same-origin (or carries no Origin/Referer at all, the
 * server/test case). False ⇒ a cross-origin browser request that should be 403'd.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const requestHost = request.headers.get('host');
  const originHost = hostOf(request.headers.get('origin'));
  const refererHost = hostOf(request.headers.get('referer'));

  // No browser-supplied origin info → server/test context → allow.
  if (!originHost && !refererHost) return true;

  // Prefer Origin; fall back to Referer host. Must match the request host.
  const claimedHost = originHost ?? refererHost;
  return !!requestHost && claimedHost === requestHost;
}
