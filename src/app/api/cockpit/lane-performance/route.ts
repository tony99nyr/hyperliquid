import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { getLanePerformanceReport } from '@/lib/performance/lane-performance-service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  if (!isSameOrigin(request)) return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  const limit = checkRateLimit(`lane-performance:${getClientIdentifier(request)}`, 30, 60_000);
  if (!limit.allowed) return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  const since = request.nextUrl.searchParams.get('since') ?? undefined;
  const lane = request.nextUrl.searchParams.get('lane') ?? undefined;
  if (since && !Number.isFinite(Date.parse(since))) return NextResponse.json({ ok: false, error: 'Invalid since timestamp' }, { status: 400 });
  const report = await getLanePerformanceReport({ since, lane });
  return NextResponse.json(report);
}
