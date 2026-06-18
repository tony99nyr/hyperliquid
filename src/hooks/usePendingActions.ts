'use client';

/**
 * Realtime hook for a session's `pending_actions` (the approval-gate queue).
 * Newest first; the latest still-'pending' row is surfaced for the popup so a
 * proposed trade appears the instant the skill writes it. Resolved rows
 * (approved/rejected/expired) stay in the list (audit) but `pending` filters to
 * the one awaiting a decision.
 */

import { useRealtimeChannel } from './useRealtimeChannel';
import { byCreatedAtDesc, mapPendingActionRow } from './realtime-row-mappers';
import type { PendingAction } from '@/types/cockpit';

export interface PendingActionsState {
  actions: PendingAction[];
  /**
   * The most-recent SKILL-authored row still awaiting a decision, or null. This
   * is the ONLY thing the approval MODAL renders — keeping it scoped to
   * `status==='pending'` preserves the hardened skill gate exactly (approve/
   * reject both guard on 'pending'; folding previews in would arm a modal that
   * 409s on Approve).
   */
  pending: PendingAction | null;
  /**
   * The most-recent OPERATOR-authored 'preview' awaiting a decision, or null.
   * Surfaced as a SEPARATE field (never merged into `pending`) so the popup can
   * route it to the operator execute path (`/api/cockpit/preview/decide`) and
   * show Claude's review — distinct from the skill approve path.
   */
  preview: PendingAction | null;
  loaded: boolean;
  subscribed: boolean;
  error: string | null;
}

export function usePendingActions(sessionId: string | null): PendingActionsState {
  const { rows, loaded, subscribed, error } = useRealtimeChannel<PendingAction>({
    table: 'pending_actions',
    sessionId,
    map: mapPendingActionRow,
    compare: byCreatedAtDesc,
  });
  const pending = rows.find((a) => a.status === 'pending') ?? null;
  const preview =
    rows.find((a) => a.status === 'preview' && a.origin === 'operator') ?? null;
  return { actions: rows, pending, preview, loaded, subscribed, error };
}
