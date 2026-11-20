/**
 * Shared guard for the same-origin HL read proxies (`/api/hl/*`).
 *
 * These routes front the public Hyperliquid `/info` endpoint so the BROWSER reads
 * candles/regime through OUR server (one shared in-process cache + 429 backoff +
 * coalescing) instead of every tab hitting api.hyperliquid.xyz directly — the
 * source of the 429s. They accept an admin OR a read-only viewer session (the
 * /cockpit page is already PIN-gated), are same-origin, and are rate-limited as a
 * backstop. READ-ONLY: no key, no orders. Call guardHlRoute only from a GET handler;
 * the viewer deny-by-default test enforces that.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { verifyReadAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';

/**
 * Run the auth → same-origin → rate-limit gate. Returns a NextResponse to send
 * (the rejection) or null when the caller may proceed. The cached server fetch
 * means even an authed client can't drive real upstream load beyond the cache
 * TTL, so the limit is generous (the cache absorbs polling).
 */
export function guardHlRoute(
  request: NextRequest,
  bucket: string,
  maxPerMin = 120,
): Promise<NextResponse | null> {
  return (async () => {
    if (!(await verifyReadAuth(request))) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (!isSameOrigin(request)) {
      return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
    }
    const limit = checkRateLimit(`${bucket}:${getClientIdentifier(request)}`, maxPerMin, 60_000);
    if (!limit.allowed) {
      return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
    }
    return null;
  })();
}
