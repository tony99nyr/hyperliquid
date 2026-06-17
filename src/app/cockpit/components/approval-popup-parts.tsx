'use client';

/**
 * Presentational sub-components for the ApprovalPopup (design handoff "Confirm
 * Order" modal). Split out of ApprovalPopup.tsx to keep each file under the
 * 600-line cap — these are pure markup + the small `levColor` threshold helper;
 * all the hardened wiring (leverage state machine, decide() POST, a11y, safety
 * gate) stays in ApprovalPopup.tsx. The leverage CONTROL is here but it is a
 * dumb view — its state lives in PopupBody.
 */

import { css } from '@styled-system/css';
import { WarningTriangle } from './WarningTriangle';
import { GH, ZONE_COLORS, TERM, fmtPx, fmtUsd, fmtPctSigned } from './panel-styles';

/** Leverage multiplier color: green <12 · amber 12–19 · red ≥20 (design handoff). */
export function levColor(leverage: number): string {
  if (leverage >= 20) return ZONE_COLORS.danger;
  if (leverage >= 12) return ZONE_COLORS.warn;
  return ZONE_COLORS.ok;
}

/** One LONG/SHORT segment of the side READOUT. Only the proposal's side is active. */
export function SideSegment({
  label,
  active,
  activeColor,
  testid,
}: {
  label: string;
  active: boolean;
  activeColor: string;
  testid?: string;
}) {
  return (
    <span
      data-testid={testid}
      aria-current={active ? 'true' : undefined}
      className={css({
        flex: 1,
        textAlign: 'center',
        fontFamily: 'sans',
        fontSize: '12.5px',
        fontWeight: 'bold',
        letterSpacing: '0.04em',
        borderRadius: '6px',
        paddingY: '8px',
        userSelect: 'none',
      })}
      style={{
        background: active ? activeColor : 'transparent',
        color: active ? TERM.darkText : GH.textMuted,
        opacity: active ? 1 : 0.55,
      }}
    >
      {label}
    </span>
  );
}

/** One label/value row in the summary box (hairline divider, last has none). */
export function SummaryRow({
  label,
  value,
  color,
  last,
}: {
  label: string;
  value: string;
  color?: string;
  last?: boolean;
}) {
  return (
    <div
      className={css({
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingY: '9px',
        _last: { borderBottom: 'none' },
      })}
      style={{ borderBottom: last ? 'none' : '1px solid rgba(255,255,255,.05)' }}
    >
      <span className={css({ fontSize: '12px', color: 'github.textMuted' })}>{label}</span>
      <span
        style={{ color: color ?? GH.text, fontFeatureSettings: '"tnum"' }}
        className={css({ fontFamily: 'mono', fontSize: '12.5px', fontWeight: 'medium' })}
      >
        {value}
      </span>
    </div>
  );
}

/** The leverage slider + presets + live margin/liq/ROE read + safety guard. */
export function LeverageControl({
  coin,
  coinMax,
  leverage,
  setLeverage,
  marginUsd,
  liqPx,
  roeAtStopPct,
  roeAtTargetPct,
  liqInsideStop,
  ackLiqInsideStop,
  setAckLiqInsideStop,
  leaderLev,
  halfLev,
}: {
  coin: string;
  coinMax: number;
  leverage: number;
  setLeverage: (v: number) => void;
  marginUsd: number;
  liqPx: number | null;
  roeAtStopPct: number | null;
  roeAtTargetPct: number | null;
  liqInsideStop: boolean;
  ackLiqInsideStop: boolean;
  setAckLiqInsideStop: (v: boolean) => void;
  leaderLev: number | null;
  halfLev: number | null;
}) {
  // A11y (Fix 5): announce the CONSEQUENCE of the slider, not just the multiplier.
  const liqText = liqPx == null ? 'n/a' : fmtPx(liqPx);
  const roeTargetText = roeAtTargetPct == null ? 'n/a' : fmtPctSigned(roeAtTargetPct);
  const sliderValueText = `${leverage}×, margin ${fmtUsd(marginUsd).replace('+', '')}, est. liq ${liqText}, ROE at target ${roeTargetText}`;
  return (
    <div
      data-testid="leverage-control"
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        marginBottom: '20px',
      })}
    >
      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' })}>
        <span className={css({ fontFamily: 'sans', fontSize: '10.5px', fontWeight: 'semibold', textTransform: 'uppercase', letterSpacing: '0.1em' })} style={{ color: '#9aa4b5' }}>
          Leverage
        </span>
        <span
          data-testid="leverage-value"
          style={{ fontFeatureSettings: '"tnum"', color: levColor(leverage) }}
          className={css({ fontFamily: 'mono', fontSize: '18px', fontWeight: 'semibold' })}
        >
          {leverage.toLocaleString('en-US', { maximumFractionDigits: 1 })}x
        </span>
      </div>

      <input
        type="range"
        data-testid="leverage-slider"
        min={1}
        max={coinMax}
        step={1}
        value={leverage}
        onChange={(e) => setLeverage(Number(e.target.value))}
        aria-label={`Leverage, 1 to ${coinMax} times`}
        aria-valuetext={sliderValueText}
        className={css({ width: '100%', cursor: 'pointer' })}
        style={{ accentColor: TERM.accent }}
      />
      <div className={css({ display: 'flex', justifyContent: 'space-between', fontFamily: 'mono', fontSize: '9.5px' })} style={{ color: TERM.faint }}>
        <span>1x</span>
        <span>
          {coinMax}x max ({coin})
        </span>
      </div>

      {/* Presets: Match leader (N×) + ½ leader. */}
      {(leaderLev != null || halfLev != null) && (
        <div className={css({ display: 'flex', gap: '6px' })}>
          {leaderLev != null && (
            <PresetButton testid="match-leader-button" label={`Match leader (${leaderLev}×)`} onClick={() => setLeverage(leaderLev)} />
          )}
          {halfLev != null && (
            <PresetButton testid="half-leader-button" label={`½ leader (${halfLev}×)`} onClick={() => setLeverage(halfLev)} />
          )}
        </div>
      )}

      {/* Live derived read: margin / liq / ROE@stop / ROE@target. */}
      <div className={css({ display: 'flex', gap: '10px', flexWrap: 'wrap' })}>
        <ReadCell label="Margin" value={fmtUsd(marginUsd).replace('+', '')} testid="leverage-margin" />
        <ReadCell label="Est. liq" value={fmtPx(liqPx)} color={liqInsideStop ? ZONE_COLORS.danger : GH.text} testid="leverage-liq" />
        <ReadCell label="ROE @ stop" value={roeAtStopPct == null ? '—' : fmtPctSigned(roeAtStopPct)} color={roeAtStopPct != null && roeAtStopPct < 0 ? ZONE_COLORS.danger : GH.text} testid="leverage-roe-stop" />
        {roeAtTargetPct != null && (
          <ReadCell label="ROE @ target" value={fmtPctSigned(roeAtTargetPct)} color={ZONE_COLORS.ok} testid="leverage-roe-target" />
        )}
      </div>

      {/* SAFETY GUARD — liquidation inside the stop. role="alert" so a screen
          reader dragging the slider HEARS the message on state change (Fix 4). */}
      {liqInsideStop && (
        <div
          data-testid="liq-inside-stop-warning"
          role="alert"
          className={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            border: '1px solid token(colors.zone.danger)',
            borderRadius: '9px',
            padding: '8px 10px',
          })}
          style={{ background: 'rgba(242,77,94,0.12)' }}
        >
          <div className={css({ display: 'flex', gap: '8px', alignItems: 'flex-start' })}>
            {/* Font-independent SVG warning triangle (no emoji → no tofu, Fix 1). */}
            <WarningTriangle />
            <span className={css({ fontSize: 'xs', color: 'zone.danger', fontWeight: 'semibold', lineHeight: '1.4' })}>
              Liquidation before stop — at {leverage}× the position liquidates before your stop can trigger. Reduce leverage.
            </span>
          </div>
          {/* Approve is GATED while this warning shows (Fix 2): clear it by
              reducing leverage, or explicitly acknowledge the broken risk plan. */}
          <label
            data-testid="liq-ack-label"
            className={css({ display: 'flex', gap: '7px', alignItems: 'flex-start', cursor: 'pointer' })}
          >
            <input
              type="checkbox"
              data-testid="liq-ack-checkbox"
              checked={ackLiqInsideStop}
              onChange={(e) => setAckLiqInsideStop(e.target.checked)}
              className={css({ marginTop: '2px', cursor: 'pointer' })}
              style={{ accentColor: ZONE_COLORS.danger }}
            />
            <span className={css({ fontSize: '11px', color: 'github.text', lineHeight: '1.4' })}>
              I understand liquidation is inside my stop
            </span>
          </label>
        </div>
      )}
    </div>
  );
}

function PresetButton({ label, onClick, testid }: { label: string; onClick: () => void; testid: string }) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className={css({
        flex: 1,
        borderRadius: '6px',
        fontFamily: 'mono',
        fontSize: '11px',
        paddingY: '7px',
        cursor: 'pointer',
        _hover: { borderColor: 'github.link', color: 'github.textBright' },
      })}
      style={{ background: TERM.focal, color: '#9aa4b5', border: '1px solid rgba(255,255,255,.08)' }}
    >
      {label}
    </button>
  );
}

function ReadCell({ label, value, color, testid }: { label: string; value: string; color?: string; testid: string }) {
  return (
    <div className={css({ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: '64px' })}>
      <span className={css({ fontFamily: 'sans', fontSize: '8px', color: 'github.textMuted', textTransform: 'uppercase', letterSpacing: '0.06em' })}>
        {label}
      </span>
      <span data-testid={testid} style={{ color: color ?? GH.text, fontFeatureSettings: '"tnum"' }} className={css({ fontFamily: 'mono', fontSize: 'sm', fontWeight: 'bold' })}>
        {value}
      </span>
    </div>
  );
}
