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
import { assertScoutPaperMode } from '@/lib/scout/scout-execution-guard';
import { paperFill } from './fill-source-paper';
import { liveFill } from './fill-source-live';
import { applyFillToPosition } from './position-tracker';
import { persistFillRow } from '@/lib/cockpit/fill-persistence-service';

/**
 * Persist a canonical fill as a Supabase `fills` row. Idempotent on
 * client_intent_id (a duplicate is silently a no-op), so re-running
 * executeIntent with the same intent records the fill exactly once. Identical in
 * both modes — never branches on `fill.source`.
 */
export async function persistFill(fill: CanonicalFill): Promise<void> {
  await persistFillRow(fill);
}

/**
 * Execute a confirmed trade intent. The mode switch is the FIRST and ONLY
 * mode-aware line; from `persistFill` onward the path is identical regardless of
 * whether the fill came from the paper book-match or a live HL confirmation.
 *
 * Persist commits BEFORE the position recompute so the ledger fold
 * (applyFillToPosition) sees the just-recorded fill (idempotent + crash-safe;
 * see fill-persistence-service).
 *
 * A zero-fill (empty/limit-not-crossed book → `sz === 0`) is NOT persisted: it
 * would burn the client_intent_id (blocking a legitimate retry once the book
 * recovers) and write a meaningless ledger row. The (empty) fill is still
 * returned so the caller can report "no fill".
 */
export async function executeIntent(intent: TradeIntent): Promise<CanonicalFill> {
  // SEAM-LEVEL safety: a scout-origin intent can NEVER execute live, no matter
  // who calls executeIntent. The boundary travels with the intent (defense in
  // depth beyond the scout-trade caller-side guard). Real money = human popup.
  if (intent.origin === 'scout') assertScoutPaperMode(getTradingMode());
  const fill = getTradingMode() === 'live' ? await liveFill(intent) : await paperFill(intent);
  if (fill.sz <= 0) return fill; // nothing filled — do not record (retry stays possible)
  await persistFill(fill);
  // Leverage is intent METADATA (not derived from the fill, so the fold stays
  // leverage-agnostic — ADR-0001). Carry it through to the positions upsert so the
  // UI can derive ROE. Reduce-only exits leave it undefined → stored value kept.
  await applyFillToPosition(fill, intent.reduceOnly ? undefined : intent.leverage);
  return fill;
}
