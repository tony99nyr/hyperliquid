/**
 * Position tracker (I/O SKELETON). The mode-AGNOSTIC half of the seam.
 *
 * `applyFillToPosition` is the single downstream consumer of a CanonicalFill:
 * it loads the current position for the coin, folds the fill in via the PURE
 * `applyFill` (pnl-business-logic.ts), and persists the new position + a P&L
 * row. It NEVER reads `fill.source` — paper and live are indistinguishable here,
 * which is exactly what the mode-agnosticism test pins down.
 *
 * Phase 1 wires the Supabase reads/writes; the pure fold is already done.
 */

import type { CanonicalFill } from '@/types/fill';
import type { Position } from '@/types/position';
import { applyFill, emptyPosition } from './pnl-business-logic';
import { applyFillToPositionRows } from '@/lib/cockpit/fill-persistence-service';

/**
 * Pure core: given the prior position (or undefined when none exists yet) and a
 * fill, compute the next position. Extracted so it is unit-testable without any
 * Supabase I/O — the mode-agnosticism test calls this directly.
 */
export function nextPosition(prior: Position | undefined, fill: CanonicalFill): Position {
  const base = prior ?? emptyPosition(fill.coin);
  return applyFill(base, fill);
}

/**
 * I/O orchestration: load the position for fill.coin + fill.sessionId from
 * Supabase, compute `nextPosition` (pure), upsert the positions row + insert a
 * pnl row, and return the new position. Delegates to the cockpit persistence
 * service. Mode-agnostic — never inspects `fill.source`.
 */
export async function applyFillToPosition(fill: CanonicalFill): Promise<Position> {
  return applyFillToPositionRows(fill);
}
