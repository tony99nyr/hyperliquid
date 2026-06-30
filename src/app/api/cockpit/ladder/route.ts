/**
 * /api/cockpit/ladder — author + list Armed Ladders (admin-authed).
 *
 *   GET                       → list ladders (newest first; ?status= filter).
 *   POST { title, thesis?, mode?, maxTotalNotionalUsd?, maxTotalLossUsd?, expiresAtMs?, rungs[] }
 *                             → create a DRAFT ladder + rungs; returns { id }.
 *
 * Creating a DRAFT moves no money and arms nothing — it only persists the plan. The
 * operator then reviews it in the preview modal and ARMS it via /ladder/arm (the
 * authorization gate). This route always authors as 'operator' (a scout proposal is
 * written by the scout's own paper path, never this admin route).
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { isSameOrigin } from '@/lib/infrastructure/auth/same-origin';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { createLadder, listLadders, listLaddersWithRungs, type NewRung } from '@/lib/ladder/ladder-service';
import type { Ladder, LadderSide, RungAction, RungTriggerKind } from '@/lib/ladder/ladder-types';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';

export const dynamic = 'force-dynamic';

const LADDER_MAX_PER_MIN = 20;
const VALID_STATUS: Ladder['status'][] = ['draft', 'armed', 'disarmed', 'done', 'expired'];
const VALID_SIDE: LadderSide[] = ['long', 'short'];
const VALID_ACTION: RungAction[] = ['open', 'add', 'reduce', 'close'];
const VALID_TRIGGER: RungTriggerKind[] = ['price_above', 'price_below', 'volume', 'funding', 'indicator'];

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const statusRaw = request.nextUrl.searchParams.get('status');
  const status = statusRaw && VALID_STATUS.includes(statusRaw as Ladder['status']) ? (statusRaw as Ladder['status']) : undefined;
  const withRungs = request.nextUrl.searchParams.get('withRungs') === '1';
  // ?archived=1 → the audit view (archived ladders only); default = active only.
  const opts = { archived: request.nextUrl.searchParams.get('archived') === '1' };
  try {
    const ladders = withRungs ? await listLaddersWithRungs(status, opts) : await listLadders(status, opts);
    return NextResponse.json({ ok: true, ladders });
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
  const limit = checkRateLimit(`ladder:${getClientIdentifier(request)}`, LADDER_MAX_PER_MIN, 60_000);
  if (!limit.allowed) return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });

  let body: {
    title?: unknown; thesis?: unknown; mode?: unknown; ocoGroupId?: unknown;
    maxTotalNotionalUsd?: unknown; maxTotalLossUsd?: unknown; expiresAtMs?: unknown; rungs?: unknown;
  };
  try { body = (await request.json()) as typeof body; } catch { return NextResponse.json({ ok: false, error: 'Invalid body' }, { status: 400 }); }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return NextResponse.json({ ok: false, error: 'title required' }, { status: 400 });
  const mode = body.mode === 'live' ? 'live' : 'paper';
  if (!Array.isArray(body.rungs) || body.rungs.length === 0) {
    return NextResponse.json({ ok: false, error: 'at least one rung required' }, { status: 400 });
  }

  // Validate each rung's enums + shape (numbers are sanity-checked; the deeper
  // risk/guardrail validation runs at ARM, against live state).
  const rungs: NewRung[] = [];
  for (let i = 0; i < body.rungs.length; i++) {
    const r = body.rungs[i] as Record<string, unknown>;
    const coin = typeof r.coin === 'string' ? r.coin.trim().toUpperCase() : '';
    if (!coin) return NextResponse.json({ ok: false, error: `rung ${i + 1}: coin required` }, { status: 400 });
    if (!VALID_SIDE.includes(r.side as LadderSide)) return NextResponse.json({ ok: false, error: `rung ${i + 1}: invalid side` }, { status: 400 });
    if (!VALID_ACTION.includes(r.action as RungAction)) return NextResponse.json({ ok: false, error: `rung ${i + 1}: invalid action` }, { status: 400 });
    if (!VALID_TRIGGER.includes(r.triggerKind as RungTriggerKind)) return NextResponse.json({ ok: false, error: `rung ${i + 1}: invalid triggerKind` }, { status: 400 });
    // reduceFrac (when present) must be a fraction in (0, 1] — reject at the API layer with a
    // clean 400 rather than leaning on the DB CHECK (which would surface as a 502). Matches
    // the bound the fire path + DB constraint enforce downstream.
    const reduceFracVal = num(r.reduceFrac);
    if (reduceFracVal != null && !(reduceFracVal > 0 && reduceFracVal <= 1)) {
      return NextResponse.json({ ok: false, error: `rung ${i + 1}: reduceFrac must be in (0, 1]` }, { status: 400 });
    }
    rungs.push({
      seq: num(r.seq) ?? i + 1,
      coin,
      side: r.side as LadderSide,
      action: r.action as RungAction,
      triggerKind: r.triggerKind as RungTriggerKind,
      triggerPx: num(r.triggerPx),
      triggerMeta: (r.triggerMeta ?? null) as NewRung['triggerMeta'],
      sizeCoins: num(r.sizeCoins),
      reduceFrac: reduceFracVal,
      riskUsd: num(r.riskUsd),
      stopFrac: num(r.stopFrac),
      leverage: num(r.leverage),
      stopPx: num(r.stopPx),
      targetPx: num(r.targetPx),
    });
  }

  try {
    const id = await createLadder({
      title,
      thesis: typeof body.thesis === 'string' ? body.thesis : null,
      author: 'operator',
      mode,
      ocoGroupId: typeof body.ocoGroupId === 'string' && body.ocoGroupId.trim() ? body.ocoGroupId.trim() : null,
      maxTotalNotionalUsd: num(body.maxTotalNotionalUsd),
      maxTotalLossUsd: num(body.maxTotalLossUsd),
      expiresAtMs: num(body.expiresAtMs),
      rungs,
    });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(err) }, { status: 502 });
  }
}
