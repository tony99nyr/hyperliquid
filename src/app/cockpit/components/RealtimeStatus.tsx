'use client';

/**
 * RealtimeStatus — a single, always-visible health dot for the Supabase realtime
 * transport (the cockpit-state source of truth: positions, P&L, health). The
 * per-table hooks each expose `subscribed`/`error`, but no panel surfaced them,
 * so a dropped channel showed stale data with no visual cue. This subscribes to
 * one representative session channel (analysis_log) and reports its posture; if
 * THIS channel is down the others almost certainly are too (same client/socket).
 *
 * Shown in the cockpit header so the operator can tell live data from frozen data
 * during a move. No session ⇒ inert ("idle").
 */

import { css } from '@styled-system/css';
import { useAnalysisStream } from '@/hooks/useAnalysisStream';
import { ZONE_COLORS, GH } from './panel-styles';

export interface RealtimeStatusProps {
  sessionId: string | null;
}

export default function RealtimeStatus({ sessionId }: RealtimeStatusProps) {
  const { subscribed, error, loaded } = useAnalysisStream(sessionId);

  const posture = !sessionId
    ? { label: 'no session', color: GH.textMuted, glyph: '○' }
    : error
      ? { label: 'reconnecting', color: ZONE_COLORS.warn, glyph: '⚠' }
      : subscribed
        ? { label: 'live', color: ZONE_COLORS.ok, glyph: '●' }
        : { label: loaded ? 'connecting' : 'connecting', color: GH.textMuted, glyph: '◌' };

  return (
    <span
      data-testid="realtime-status"
      data-state={posture.label}
      title={`Cockpit realtime feed: ${posture.label}${error ? ` (${error})` : ''}`}
      style={{ color: posture.color, borderColor: posture.color }}
      className={css({
        fontSize: 'xs',
        fontFamily: 'mono',
        fontWeight: 'bold',
        border: '1px solid',
        borderRadius: '6px',
        paddingX: '8px',
        paddingY: '4px',
        whiteSpace: 'nowrap',
      })}
    >
      {posture.glyph} feed {posture.label}
    </span>
  );
}
