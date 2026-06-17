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
      <div role="tablist" aria-label="Supporting panels" className={css({ display: 'flex', gap: '6px' })}>
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`secondary-tab-${t.id}`}
              data-active={active}
              onClick={() => setTab(t.id)}
              style={active ? { background: '#58a6ff', color: '#010409' } : undefined}
              className={css({
                fontFamily: 'label',
                fontSize: '10px',
                fontWeight: 'bold',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                border: '1px solid token(colors.github.border)',
                borderRadius: '6px',
                paddingX: '10px',
                paddingY: '5px',
                cursor: 'pointer',
                color: 'github.textMuted',
                bg: 'github.bg',
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
