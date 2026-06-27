/**
 * Armed Ladder runtime kill-switches (server-only). TWO independent gates so "go live
 * for MANUAL execution" never implies "let the watcher fire autonomously":
 *
 *   - isLadderLiveEnabled()    → a LIVE-mode ladder may be ARMED (operator authorization).
 *   - isLadderAutofireEnabled()→ the watcher / fire-rung route may AUTONOMOUSLY execute a
 *                                pre-armed rung (the "automatic execute" switch).
 *
 * Both default OFF and are orthogonal to TRADING_MODE (paper↔live). The fire route (P1d)
 * checks isLadderAutofireEnabled() as its SINGLE enforcement point before any AFK fill —
 * so the operator can run fully live for manual trading with auto-fire still hard-off.
 */

import 'server-only';
import { validateEnv } from '@/lib/env/env';

export function isLadderLiveEnabled(): boolean {
  return validateEnv().LADDER_LIVE_ENABLED;
}

export function isLadderAutofireEnabled(): boolean {
  return validateEnv().LADDER_AUTOFIRE_ENABLED;
}
