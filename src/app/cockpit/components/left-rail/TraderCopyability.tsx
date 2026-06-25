'use client';

/**
 * TraderCopyability — the on-demand vetting verdict in the trader drawer. Renders the
 * persisted trader_evaluations fingerprint (verdict + the *why* + gating chips) and a
 * "vet now" button that enqueues a fresh evaluation (worker fills it; we poll). Per
 * A4 the verdict certifies operational feasibility, NOT forward profit.
 */

import { css } from '@styled-system/css';
import { useTraderEvaluation, type TraderEvaluation } from '@/hooks/useTraderEvaluation';
import { GH, ZONE_COLORS } from '../panel-styles';

const VERDICT_COLOR: Record<TraderEvaluation['verdict'], string> = {
  follow: ZONE_COLORS.ok, caution: ZONE_COLORS.warn, avoid: ZONE_COLORS.danger,
};

function num(v: unknown, d = 2): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—';
}
function pct(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—';
}

function Chip({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <span className={css({ display: 'flex', flexDirection: 'column', gap: '1px' })}>
      <span className={css({ fontFamily: 'label', fontSize: '8px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.05em' })}>{label}</span>
      <span style={{ color: danger ? ZONE_COLORS.danger : GH.textBright, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: '11px', fontWeight: 'bold' })}>{value}</span>
    </span>
  );
}

export default function TraderCopyability({ address }: { address: string }) {
  const { evaluation, loading, vetting, error, vet } = useTraderEvaluation(address);

  const vetButton = (label: string) => (
    <button
      type="button"
      data-testid="copyability-vet"
      disabled={vetting}
      aria-busy={vetting}
      onClick={() => void vet()}
      className={css({ alignSelf: 'flex-start', fontFamily: 'mono', fontSize: '10px', color: 'github.link', bg: 'github.bg', border: '1px solid token(colors.github.borderSubtle)', borderRadius: '5px', padding: '5px 8px', cursor: vetting ? 'wait' : 'pointer', _disabled: { opacity: 0.6 }, _hover: { borderColor: 'github.link' }, _focusVisible: { outline: '2px solid token(colors.github.link)' } })}
    >
      {vetting ? 'vetting… (worker fetching fills)' : label}
    </button>
  );

  if (loading) {
    return <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.textMuted' })}>loading…</span>;
  }

  const m = evaluation?.metrics ?? {};

  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '8px' })}>
      {!evaluation ? (
        <>
          <span className={css({ fontFamily: 'mono', fontSize: '11px', color: 'github.textMuted' })}>Not yet vetted.</span>
          {vetButton('Vet copyability →')}
        </>
      ) : (
        <>
          <div className={css({ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' })}>
            <span
              data-testid="copyability-verdict"
              data-verdict={evaluation.verdict}
              style={{ color: VERDICT_COLOR[evaluation.verdict], borderColor: VERDICT_COLOR[evaluation.verdict] }}
              className={css({ fontFamily: 'mono', fontSize: '11px', fontWeight: 'bold', border: '1px solid', borderRadius: '4px', paddingX: '6px', paddingY: '1px', textTransform: 'uppercase' })}
            >
              {evaluation.verdict}
            </span>
            <span className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>{evaluation.persistenceConfidence} · {evaluation.windowLabel}</span>
          </div>
          {typeof m.why === 'string' && (
            <span className={css({ fontFamily: 'mono', fontSize: '10px', color: 'github.text', lineHeight: 1.4 })}>{m.why}</span>
          )}
          <div className={css({ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px 12px' })}>
            <Chip label="Win%" value={pct(m.winRate)} />
            <Chip label="Med Hold" value={typeof m.medianHoldHours === 'number' ? `${num(m.medianHoldHours, 1)}h` : '—'} />
            <Chip label="Round-trips" value={num(m.roundTrips, 0)} />
            <Chip label="Adds/Trip" value={num(m.addsPerTrip, 1)} danger={typeof m.addsPerTrip === 'number' && m.addsPerTrip > 3} />
            <Chip label="Worst/Win" value={typeof m.worstLossVsMedianWin === 'number' ? `${num(m.worstLossVsMedianWin, 1)}×` : '—'} danger={typeof m.worstLossVsMedianWin === 'number' && m.worstLossVsMedianWin > 6} />
            <Chip label="Liquidations" value={num(m.liquidations, 0)} danger={typeof m.liquidations === 'number' && m.liquidations > 0} />
          </div>
          <span className={css({ fontFamily: 'mono', fontSize: '8px', color: 'github.textMuted', lineHeight: 1.4 })}>
            Certifies operational feasibility (copyable-with-a-stop), not forward profit. {evaluation.fillsSeen.toLocaleString('en-US')} fills sampled.
          </span>
          {vetButton('Re-vet →')}
        </>
      )}
      {vetting && (
        <span role="status" data-testid="copyability-vetting" className={css({ fontFamily: 'mono', fontSize: '9px', color: 'github.textMuted' })}>
          Vetting — worker fetching fills (up to 45s)…
        </span>
      )}
      {error && <span role="alert" style={{ color: ZONE_COLORS.danger }} className={css({ fontFamily: 'mono', fontSize: '9px' })}>{error}</span>}
    </div>
  );
}
