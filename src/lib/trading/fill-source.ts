/**
 * THE seam (the crux). `executeIntent` is the ONE place in the codebase that
 * branches on TRADING_MODE. Everything after the branch — persist, apply to
 * position — is identical and mode-unaware. Flipping to live = setting
 * TRADING_MODE=live in the deploy env; no other code changes. See ADR-0001.
 *
 *   executeIntent(intent)
 *     ├─ TRADING_MODE === 'live' ? liveFill(intent) : paperFill(intent)   ← only branch
 *     ├─ persistFill(fill)            ← identical both modes (Supabase fills row)
 *     └─ applyFillToPosition(fill)    ← identical both modes (positions + pnl)
 */

import type { CanonicalFill, TradeIntent } from '@/types/fill';
import { getTradingMode } from '@/lib/env/mode';
import { paperFill } from './fill-source-paper';
import { liveFill } from './fill-source-live';
import { applyFillToPosition } from './position-tracker';

/**
 * Persist a canonical fill (Phase 1: Supabase `fills` row, unique on
 * client_intent_id for idempotency). Skeleton until the cockpit writers exist.
 */
export async function persistFill(_fill: CanonicalFill): Promise<void> {
  throw new Error('persistFill: not implemented in Phase 0 (Phase 1 wires the Supabase fills row)');
}

/**
 * Execute a confirmed trade intent. The mode switch is the FIRST and ONLY
 * mode-aware line; from `persistFill` onward the path is identical regardless of
 * whether the fill came from the paper book-match or a live HL confirmation.
 */
export async function executeIntent(intent: TradeIntent): Promise<CanonicalFill> {
  const fill = getTradingMode() === 'live' ? await liveFill(intent) : await paperFill(intent);
  await persistFill(fill);
  await applyFillToPosition(fill);
  return fill;
}
