/**
 * POST /api/agent/action: scoped agent actions (ADR-0009).
 *
 *   { action: 'tighten-stop', coin, triggerPx }  -> move the protective stop tighter.
 *   { action: 'reduce', coin, fraction }         -> close a fraction (0 < f <= 1) reduce-only.
 *   { action: 'take-profit', coin, triggerPx }   -> place a reduce-only take-profit when none rests.
 *
 * The agent calls this from outside production with a dedicated bearer token, after the
 * operator said yes. Every action can only reduce risk: none can open, add, flip,
 * loosen a stop or remove an order. Gated by AGENT_ACTIONS_ENABLED (default OFF).
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronBearer, getClientIdentifier } from '@/lib/infrastructure/auth/auth';
import { checkRateLimit } from '@/lib/infrastructure/rate-limiting/in-memory-rate-limit';
import { extractErrorMessage } from '@/lib/infrastructure/logging/logger';
import { isAgentActionsEnabled, getAgentActionToken } from '@/lib/agent-actions/agent-action-config';
import { parseAgentActionRequest } from '@/lib/agent-actions/agent-action-business-logic';
import { placeTakeProfit, reduceClose, tightenStop } from '@/lib/agent-actions/agent-action-service';

export const dynamic = 'force-dynamic';

const MAX_PER_MIN = 6;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1) Kill switch FIRST: when off the endpoint does nothing, for anyone.
  if (!isAgentActionsEnabled()) {
    return NextResponse.json({ ok: false, error: 'Agent actions disabled (AGENT_ACTIONS_ENABLED off)' }, { status: 403 });
  }
  // 2) The dedicated token only. The admin PIN does not open this route.
  if (!verifyCronBearer(request, getAgentActionToken())) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  // 3) Rate limit before any work.
  const limit = checkRateLimit(`agent-action:${getClientIdentifier(request)}`, MAX_PER_MIN, 60_000);
  if (!limit.allowed) return NextResponse.json({ ok: false, error: 'Too many requests' }, { status: 429 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = parseAgentActionRequest(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  try {
    const req = parsed.request;
    const result =
      req.action === 'tighten-stop'
        ? await tightenStop({ coin: req.coin, triggerPx: req.triggerPx })
        : req.action === 'take-profit'
          ? await placeTakeProfit({ coin: req.coin, triggerPx: req.triggerPx })
          : await reduceClose({ coin: req.coin, fraction: req.fraction });
    // Not done is a 409: the request was valid, the state did not allow it. A not-done
    // take-profit that carries takeProfitOid names an order that rests on the exchange.
    return NextResponse.json({ ok: result.done, action: req.action, ...result }, { status: result.done ? 200 : 409 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMessage(e) }, { status: 500 });
  }
}
