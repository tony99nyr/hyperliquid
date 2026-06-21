'use client';

/**
 * OpportunityCard — one coin's deterministic rubric read. Numbers-first terminal
 * card: score (integer + band) · direction · GO/WATCH/NO-EDGE badge (NO-EDGE is
 * CALM) · 4-segment pillar bar (regime/leaders/carry/micro) · key levels ·
 * confidence dots · an "ask Claude" chip. Stale data is dimmed + tagged. Tapping
 * the card selects the coin (drives the chart). All thresholds are pure helpers.
 */

import { css } from '@styled-system/css';
import { GH, TERM, ZONE_COLORS, fmtPx } from '../panel-styles';
import {
  badgeMeta, directionMeta, pillarSegments, confidenceDots, isStale, formatScore,
  buildAskClaudeSnapshot, type OpportunityCardModel,
} from './opportunity-helpers';

export interface OpportunityCardProps {
  model: OpportunityCardModel;
  now: number;
  selected?: boolean;
  onSelect?: (coin: string) => void;
  onAskClaude?: (snapshot: Record<string, unknown>) => void;
}

export default function OpportunityCard({ model, now, selected, onSelect, onAskClaude }: OpportunityCardProps) {
  const stale = isStale(model.computedAt, now);
  const badge = badgeMeta(model.badge);
  // Only show a direction when there's an actual edge — a NO-EDGE card shows "—"
  // (don't imply LONG/SHORT when the rubric has no call).
  const dir = directionMeta(model.chosenSide);
  const { score, band } = formatScore(model.display.opportunity, model.display.scoreBandLow, model.display.scoreBandHigh);
  const dots = confidenceDots(model.confidence);
  const segs = pillarSegments(model.display);
  const d = model.display;

  return (
    <div
      data-testid="opportunity-card"
      data-coin={model.coin}
      data-badge={model.badge}
      data-stale={stale ? 'true' : 'false'}
      data-active={selected ? 'true' : 'false'}
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(model.coin)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(model.coin); } }}
      className={css({
        bg: 'cockpit.panel',
        border: '1px solid token(colors.github.border)',
        borderRadius: '10px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        cursor: 'pointer',
        opacity: stale ? 0.5 : 1,
        outline: selected ? `1px solid ${TERM.accent}` : 'none',
        transition: 'opacity 120ms, outline 120ms',
        _hover: { borderColor: 'rgba(91,140,255,0.4)' },
      })}
      style={{ outline: selected ? `1px solid ${TERM.accent}` : undefined }}
    >
      {/* header: coin + direction + badge */}
      <div className={css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' })}>
        <div className={css({ display: 'flex', alignItems: 'baseline', gap: '8px' })}>
          <span className={css({ fontFamily: 'mono', fontSize: 'md', fontWeight: 'bold', color: 'github.textBright' })}>{model.coin}</span>
          <span style={{ color: dir.color }} className={css({ fontFamily: 'label', fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.06em' })}>{dir.label}</span>
        </div>
        <span
          data-testid="opportunity-badge"
          style={{ color: badge.color, borderColor: badge.color }}
          className={css({ fontFamily: 'label', fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.08em', padding: '2px 7px', borderRadius: '5px', border: '1px solid', opacity: badge.muted ? 0.7 : 1 })}
        >
          {badge.label}
        </span>
      </div>

      {/* score + confidence dots */}
      <div className={css({ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' })}>
        <div className={css({ display: 'flex', alignItems: 'baseline', gap: '4px' })}>
          <span style={{ color: badge.muted ? GH.textMuted : dir.color, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '28px', fontWeight: 800, lineHeight: '1' })}>{score}</span>
          {band && <span className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.textMuted' })}>{band}</span>}
        </div>
        <div aria-label={`confidence ${dots} of 5`} className={css({ display: 'flex', gap: '3px', alignItems: 'center' })}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={css({ width: '5px', height: '5px', borderRadius: '50%' })} style={{ background: i < dots ? TERM.accent : GH.borderSubtle }} />
          ))}
        </div>
      </div>

      {/* 4-segment pillar bar */}
      <div data-testid="pillar-bar" className={css({ display: 'flex', gap: '4px' })}>
        {segs.map((s) => (
          <div key={s.key} data-pillar={s.key} className={css({ flex: 1, display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'center' })}>
            <div className={css({ width: '100%', height: '4px', borderRadius: '2px', overflow: 'hidden', bg: 'github.bg' })}>
              <div style={{ width: `${Math.max(0, Math.min(100, s.value))}%`, height: '100%', background: s.color }} />
            </div>
            <span className={css({ fontFamily: 'label', fontSize: '8px', color: 'github.textMuted', letterSpacing: '0.04em' })}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* levels */}
      <div className={css({ display: 'flex', justifyContent: 'space-between', fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>
        <span>entry {fmtPx(d.entryLow)}–{fmtPx(d.entryHigh)}</span>
        <span style={{ color: ZONE_COLORS.danger }}>inval {fmtPx(d.invalidation)}</span>
        <span style={{ color: ZONE_COLORS.ok }}>tgt {fmtPx(d.target)}</span>
      </div>

      {/* footer: reason + ask */}
      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' })}>
        <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>
          {model.noTradeReason ? model.noTradeReason.replace(/-/g, ' ') : model.badge === 'GO' ? 'setup' : 'watch'}
        </span>
        {onAskClaude && (
          <button
            type="button"
            data-testid="ask-claude"
            onClick={(e) => { e.stopPropagation(); onAskClaude(buildAskClaudeSnapshot(model)); }}
            className={css({ fontFamily: 'label', fontSize: '9px', color: 'cockpit.accent', background: 'transparent', border: '1px solid rgba(91,140,255,0.3)', borderRadius: '5px', padding: '2px 7px', cursor: 'pointer', letterSpacing: '0.04em', _hover: { borderColor: 'cockpit.accent' } })}
          >
            ⌕ ask
          </button>
        )}
      </div>
    </div>
  );
}
