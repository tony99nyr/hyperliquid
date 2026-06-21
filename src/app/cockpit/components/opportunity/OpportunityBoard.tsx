'use client';

/**
 * OpportunityBoard — the deterministic rubric read for every scanned coin, the
 * "where's the opportunity?" half of the cockpit. Reads rubric_scores (Supabase
 * realtime, zero client HL calls). One OpportunityCard per coin; tapping a card
 * selects the coin (drives the chart). Calm empty state while loading. Accepts a
 * rows override for tests/RSC seed.
 */

import { useMemo } from 'react';
import { css } from '@styled-system/css';
import { useRubricScores } from '@/hooks/useRubricScores';
import type { RubricScoreUiRow } from '@/hooks/realtime-row-mappers';
import { toCardModels } from './opportunity-helpers';
import OpportunityCard from './OpportunityCard';

export interface OpportunityBoardProps {
  /** Display/selection order (the scan universe). */
  order?: string[];
  selectedCoin?: string;
  onSelectCoin?: (coin: string) => void;
  onAskClaude?: (snapshot: Record<string, unknown>) => void;
  /** Test/RSC seed: render fixed rows instead of subscribing. */
  rowsOverride?: RubricScoreUiRow[];
  /** Injectable clock for deterministic staleness in tests. */
  now?: number;
}

export default function OpportunityBoard({ order = [], selectedCoin, onSelectCoin, onAskClaude, rowsOverride, now }: OpportunityBoardProps) {
  // Under an override (tests/RSC seed) keep the realtime subscription inert.
  const live = useRubricScores({ enabled: rowsOverride === undefined });
  const rows = rowsOverride ?? live.rows;
  const models = useMemo(() => toCardModels(rows, order), [rows, order]);
  const clock = now ?? Date.now();

  return (
    <section data-testid="opportunity-board" className={css({ display: 'flex', flexDirection: 'column', gap: '10px' })}>
      <header className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
        <h2 className={css({ fontFamily: 'label', fontSize: 'sm', fontWeight: 'bold', color: 'github.textBright', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
          Opportunities
        </h2>
        <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>rubric · deterministic</span>
      </header>

      {models.length === 0 ? (
        <div data-testid="opportunity-empty" className={css({ fontFamily: 'mono', fontSize: 'xs', color: 'github.textMuted', padding: '14px', textAlign: 'center', bg: 'cockpit.panel', border: '1px solid token(colors.github.border)', borderRadius: '10px' })}>
          {rowsOverride === undefined && !live.loaded ? 'loading opportunity reads…' : 'no rubric reads yet — the scan populates these'}
        </div>
      ) : (
        <div className={css({ display: 'grid', gridTemplateColumns: { base: '1fr', sm: 'repeat(2, 1fr)', lg: '1fr' }, gap: '10px' })}>
          {models.map((m) => (
            <OpportunityCard key={m.coin} model={m} now={clock} selected={selectedCoin?.toUpperCase() === m.coin} onSelect={onSelectCoin} onAskClaude={onAskClaude} />
          ))}
        </div>
      )}
    </section>
  );
}
