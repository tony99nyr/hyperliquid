'use client';

/**
 * SecondaryStrip — tucks the supporting panels (Analysis stream, Hypotheses,
 * Claude context) into a tabbed strip so they stay present without competing with
 * the chart. Tabs are keyboard-navigable; the active panel is the only one
 * mounted (the realtime hooks subscribe lazily, one channel per visible tab).
 */

import { useState } from 'react';
import { css } from '@styled-system/css';
import AnalysisStream from './AnalysisStream';
import HypothesisBoard from './HypothesisBoard';
import ContextGauge from './ContextGauge';
import { panelSurface } from './panel-styles';

export interface SecondaryStripProps {
  sessionId: string | null;
}

type Tab = 'analysis' | 'hypotheses' | 'context';
const TABS: { id: Tab; label: string }[] = [
  { id: 'analysis', label: 'Analysis' },
  { id: 'hypotheses', label: 'Hypotheses' },
  { id: 'context', label: 'Context' },
];

export default function SecondaryStrip({ sessionId }: SecondaryStripProps) {
  const [tab, setTab] = useState<Tab>('analysis');
  return (
    <section
      data-testid="secondary-strip"
      className={css({ ...panelSurface, padding: '10px', display: 'flex', flexDirection: 'column', gap: '10px' })}
    >
      <div role="group" aria-label="Supporting panels" className={css({ display: 'flex', gap: '6px' })}>
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={active}
              data-testid={`secondary-tab-${t.id}`}
              data-active={active}
              onClick={() => setTab(t.id)}
              style={{
                color: active ? '#e8ebf2' : '#8b95a6',
                borderBottom: active ? '2px solid #5b8cff' : '2px solid transparent',
              }}
              className={css({
                fontFamily: 'sans',
                fontSize: '12px',
                fontWeight: 'semibold',
                border: 'none',
                background: 'none',
                paddingX: '15px',
                paddingY: '9px',
                cursor: 'pointer',
                _hover: { color: 'github.textBright' },
              })}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div>
        {tab === 'analysis' && <AnalysisStream sessionId={sessionId} />}
        {tab === 'hypotheses' && <HypothesisBoard sessionId={sessionId} />}
        {tab === 'context' && <ContextGauge sessionId={sessionId} />}
      </div>
    </section>
  );
}
