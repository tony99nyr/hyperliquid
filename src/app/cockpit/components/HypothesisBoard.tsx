'use client';

/**
 * HypothesisBoard — the trade theses the human + Claude are tracking, with their
 * outcomes. Open hypotheses are foregrounded; resolved ones show their terminal
 * status (confirmed / invalidated / resolved) + note. Realtime via useHypotheses.
 */

import { css } from '@styled-system/css';
import type { Hypothesis, HypothesisStatus } from '@/types/cockpit';
import { useHypotheses } from '@/hooks/useHypotheses';
import { GH, ZONE_COLORS } from './panel-styles';

export interface HypothesisBoardProps {
  sessionId: string | null;
  /** Test/RSC seed: render fixed hypotheses instead of subscribing. */
  hypothesesOverride?: Hypothesis[];
}

const STATUS_COLOR: Record<HypothesisStatus, string> = {
  open: GH.textMuted,
  confirmed: ZONE_COLORS.ok,
  invalidated: ZONE_COLORS.danger,
  resolved: '#58a6ff',
};

function HypothesisItem({ h }: { h: Hypothesis }) {
  const color = STATUS_COLOR[h.status];
  return (
    <li
      data-testid="hypothesis-item"
      data-status={h.status}
      className={css({
        bg: 'github.bg',
        border: '1px solid token(colors.github.borderSubtle)',
        borderRadius: '6px',
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      })}
    >
      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' })}>
        <span className={css({ fontSize: 'xs', color: 'github.text' })}>{h.statement}</span>
        <span
          style={{ color, borderColor: color }}
          className={css({
            fontSize: '10px',
            fontFamily: 'mono',
            textTransform: 'uppercase',
            border: '1px solid',
            borderRadius: '4px',
            paddingX: '6px',
            paddingY: '1px',
            whiteSpace: 'nowrap',
          })}
        >
          {h.status}
        </span>
      </div>
      {h.resolutionNote && (
        <span className={css({ fontSize: '11px', color: 'github.textMuted', fontStyle: 'italic' })}>
          {h.resolutionNote}
        </span>
      )}
    </li>
  );
}

export default function HypothesisBoard({ sessionId, hypothesesOverride }: HypothesisBoardProps) {
  const live = useHypotheses(hypothesesOverride === undefined ? sessionId : null);
  const all = hypothesesOverride ?? live.hypotheses;
  const open = all.filter((h) => h.status === 'open');
  const resolved = all.filter((h) => h.status !== 'open');

  return (
    <section
      data-testid="hypothesis-board"
      className={css({
        bg: 'github.bgSecondary',
        border: '1px solid token(colors.github.border)',
        borderRadius: '8px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      })}
    >
      <h2 className={css({ fontSize: 'sm', fontWeight: 'semibold', color: 'github.textBright' })}>
        Hypotheses
      </h2>

      {all.length === 0 ? (
        <span className={css({ fontSize: 'xs', color: 'github.textMuted' })}>
          No hypotheses tracked yet.
        </span>
      ) : (
        <>
          {open.length > 0 && (
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '6px' })}>
              <span className={css({ fontSize: '10px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.05em' })}>
                Open
              </span>
              <ul className={css({ display: 'flex', flexDirection: 'column', gap: '6px', listStyle: 'none' })}>
                {open.map((h) => <HypothesisItem key={h.id} h={h} />)}
              </ul>
            </div>
          )}
          {resolved.length > 0 && (
            <div className={css({ display: 'flex', flexDirection: 'column', gap: '6px' })}>
              <span className={css({ fontSize: '10px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.05em' })}>
                Resolved
              </span>
              <ul className={css({ display: 'flex', flexDirection: 'column', gap: '6px', listStyle: 'none' })}>
                {resolved.map((h) => <HypothesisItem key={h.id} h={h} />)}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
