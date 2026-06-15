'use client';

/**
 * AnalysisStream — Claude's live analysis_log feed, newest first. Each line shows
 * the emitting skill (source), a severity-colored marker, the message, and a
 * relative time. Realtime via useAnalysisStream (Supabase realtime).
 */

import { useEffect, useState } from 'react';
import { css } from '@styled-system/css';
import type { AnalysisLogEntry } from '@/types/cockpit';
import { useAnalysisStream } from '@/hooks/useAnalysisStream';
import { severityColor, GH } from './panel-styles';

export interface AnalysisStreamProps {
  sessionId: string | null;
  /** Test/RSC seed: render fixed entries instead of subscribing. */
  entriesOverride?: AnalysisLogEntry[];
}

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

export default function AnalysisStream({ sessionId, entriesOverride }: AnalysisStreamProps) {
  const live = useAnalysisStream(entriesOverride === undefined ? sessionId : null);
  const entries = entriesOverride ?? live.entries;

  // `now` drives relative timestamps; refreshed on an interval (never read
  // impurely during render). Lazy init keeps the first paint stable.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <section
      data-testid="analysis-stream"
      className={css({
        bg: 'github.bgSecondary',
        border: '1px solid token(colors.github.border)',
        borderRadius: '8px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minHeight: '0',
      })}
    >
      <h2 className={css({ fontSize: 'sm', fontWeight: 'semibold', color: 'github.textBright' })}>
        Analysis Stream
      </h2>
      {entries.length === 0 ? (
        <span className={css({ fontSize: 'xs', color: 'github.textMuted' })}>
          No analysis yet — run a skill to populate the stream.
        </span>
      ) : (
        <ul
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            listStyle: 'none',
            overflowY: 'auto',
            maxHeight: '420px',
          })}
        >
          {entries.map((e) => (
            <li
              key={e.id}
              data-testid="analysis-entry"
              data-severity={e.severity}
              style={{ borderLeft: `3px solid ${severityColor(e.severity)}` }}
              className={css({
                bg: 'github.bg',
                paddingX: '8px',
                paddingY: '6px',
                borderRadius: '4px',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
              })}
            >
              <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
                <span style={{ color: severityColor(e.severity) }} className={css({ fontSize: '10px', fontFamily: 'mono', textTransform: 'uppercase' })}>
                  {e.source}
                </span>
                <span style={{ color: GH.textMuted }} className={css({ fontSize: '10px', fontFamily: 'mono' })}>
                  {relTime(e.createdAt, now)} ago
                </span>
              </div>
              <span className={css({ fontSize: 'xs', color: 'github.text' })}>{e.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
