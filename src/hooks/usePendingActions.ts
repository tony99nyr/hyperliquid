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
  /** The most-recent row still awaiting a decision, or null. */
  pending: PendingAction | null;
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
  return { actions: rows, pending, loaded, subscribed, error };
}
