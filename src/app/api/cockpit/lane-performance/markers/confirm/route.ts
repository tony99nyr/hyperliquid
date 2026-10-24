import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { confirmPerformanceMarker } from '@/lib/performance/lane-performance-service';

export const dynamic = 'force-dynamic';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  if (!isSameOrigin(request)) return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  const limit = checkRateLimit(`lane-performance-confirm:${getClientIdentifier(request)}`, 30, 60_000);
  if (!limit.allowed) return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  const body: unknown = await request.json().catch(() => null);
  const id = typeof body === 'object' && body !== null && 'id' in body ? body.id : null;
  if (typeof id !== 'string' || !UUID.test(id)) return NextResponse.json({ ok: false, error: 'Invalid marker id' }, { status: 400 });
  try {
    const marker = await confirmPerformanceMarker(id);
    return NextResponse.json({ ok: true, marker });
  } catch {
    return NextResponse.json({ ok: false, error: 'Marker not found or already confirmed' }, { status: 409 });
  }
}
