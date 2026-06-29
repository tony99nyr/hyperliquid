/**
 * GET /api/cockpit/ladder/[id] — one ladder WITH its rungs (admin-authed, read-only).
 *
 * The list endpoint returns ladders without rungs; the detail/review modal needs the
 * rungs to render the plan + recompute the §3.5 risk preview client-side before arming.
 * Static sibling segments (arm/disarm/fire-rung) take precedence over this dynamic [id].
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/infrastructure/auth/auth';
import { getLadderWithRungs } from '@/lib/ladder/ladder-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  const ladderId = id?.trim();
  if (!ladderId) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  try {
    const ladder = await getLadderWithRungs(ladderId);
    if (!ladder) return NextResponse.json({ ok: false, error: 'ladder not found' }, { status: 404 });
    return NextResponse.json({ ok: true, ladder });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
}
