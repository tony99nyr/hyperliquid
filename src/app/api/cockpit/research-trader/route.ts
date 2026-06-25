/**
 * /api/cockpit/research-trader — on-demand trader vetting (PR-3).
 *
 *   POST { address }  → ENQUEUE a vetting request (the NAS worker drains it). Admin-authed.
 *   GET  ?address=0x… → the latest persisted trader_evaluations fingerprint (or null).
 *
 * Vercel only enqueues + reads; the heavy fill fetch + fingerprint run on the worker
 * (review A3). The persisted row is the one-evaluation-two-consumers contract.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { enqueueEvaluation, getLatestEvaluation } from '@/lib/hyperliquid/research-trader-service';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

const MAX_PER_MIN = 20;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const address = request.nextUrl.searchParams.get('address') ?? '';
  if (!address) return NextResponse.json({ ok: false, error: 'address required' }, { status: 400 });
  try {
    const evaluation = await getLatestEvaluation(address);
    return NextResponse.json({ ok: true, evaluation });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!isSameOrigin(request)) {
    return NextResponse.json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limit = checkRateLimit(`research-trader:${getClientIdentifier(request)}`, MAX_PER_MIN, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  }
  let address = '';
  try {
    const body = (await request.json()) as { address?: unknown };
    address = typeof body.address === 'string' ? body.address : '';
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }
  if (!address) return NextResponse.json({ ok: false, error: 'address required' }, { status: 400 });
  try {
    const { queued } = await enqueueEvaluation(address);
    return NextResponse.json({ ok: true, queued });
  } catch (err) {
    console.error('[research-trader] enqueue failed:', err);
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
}
