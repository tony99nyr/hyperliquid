'use client';

/**
 * SafeExitButton — the always-visible dead-man's-switch panic button.
 *
 * Sticky + prominent (zone.danger) whenever a session is active. It shows the
 * Safe-Exit plan freshness ("plan updated Ns ago" when Claude is keeping it
 * armed, vs "Claude offline — will market-close full position" when stale/absent)
 * so the operator knows what firing will do. One confirm step ("Exit full
 * position now?") guards against a fat-finger, then POSTs /api/cockpit/safe-exit.
 *
 * Crucially, it does NOT depend on Claude or the Analysis/health panels: the
 * server route resolves the live position itself and executes directly. It works
 * even if every other panel is stale. The result (executed / usedFallback) is
 * surfaced after firing.
 */

import { useState } from 'react';
import { css } from '@styled-system/css';
import type { SafeExitPlan } from '@/types/cockpit';
import { useSafeExitPlan } from '@/hooks/useSafeExitPlan';
import { safeExitStatus } from './safe-exit-button-helpers';
import { ZONE_COLORS } from './panel-styles';

export interface SafeExitButtonProps {
  sessionId: string | null;
  /** Test/RSC seed: render a fixed plan + freshness instead of subscribing. */
  planOverride?: { plan: SafeExitPlan | null; fresh: boolean; ageMs: number | null };
}

interface FireResult {
  executed: boolean;
  usedFallback: boolean;
  error?: string;
}

export default function SafeExitButton({ sessionId, planOverride }: SafeExitButtonProps) {
  const live = useSafeExitPlan(planOverride === undefined ? sessionId : null);
  const { plan, fresh, ageMs } = planOverride ?? live;

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FireResult | null>(null);

  if (!sessionId) return null;

  const status = safeExitStatus(plan, fresh, ageMs);

  async function fire(): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch('/api/cockpit/safe-exit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = (await res.json().catch(() => ({}))) as FireResult & { error?: string };
      if (!res.ok) {
        setResult({ executed: false, usedFallback: false, error: json.error ?? `Failed (${res.status})` });
      } else {
        setResult({ executed: Boolean(json.executed), usedFallback: Boolean(json.usedFallback) });
      }
    } catch {
      setResult({ executed: false, usedFallback: false, error: 'Network error — retry.' });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section
      data-testid="safe-exit"
      className={css({
        position: 'sticky',
        bottom: '0',
        zIndex: 20,
        bg: 'github.bgSecondary',
        border: '1px solid token(colors.zone.danger)',
        borderRadius: '10px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        boxShadow: '0 -4px 16px rgba(0,0,0,0.4)',
      })}
    >
      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' })}>
        <span className={css({ fontSize: 'sm', fontWeight: 'bold', color: 'zone.danger' })}>Safe-Exit</span>
        <span
          data-testid="safe-exit-status"
          data-tone={status.tone}
          style={{ color: status.tone === 'ok' ? ZONE_COLORS.ok : ZONE_COLORS.danger }}
          className={css({ fontSize: 'xs', fontFamily: 'mono' })}
        >
          {status.label}
        </span>
      </div>

      <p className={css({ fontSize: 'xs', color: 'github.textMuted', lineHeight: '1.4' })}>{status.detail}</p>

      {result ? (
        <p
          data-testid="safe-exit-result"
          style={{ color: result.error ? ZONE_COLORS.danger : ZONE_COLORS.ok }}
          className={css({ fontSize: 'xs', fontFamily: 'mono' })}
        >
          {result.error
            ? result.error
            : `Executed${result.usedFallback ? ' (market-close fallback)' : ' (fresh plan)'}.`}
        </p>
      ) : confirming ? (
        <div className={css({ display: 'flex', gap: '8px' })}>
          <button
            type="button"
            data-testid="safe-exit-cancel"
            disabled={busy}
            onClick={() => setConfirming(false)}
            className={css({
              flex: 1,
              bg: 'github.bg',
              border: '1px solid token(colors.github.border)',
              borderRadius: '8px',
              color: 'github.text',
              fontSize: 'sm',
              paddingY: '10px',
              cursor: 'pointer',
              _disabled: { opacity: 0.5 },
            })}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="safe-exit-confirm"
            disabled={busy}
            onClick={() => void fire()}
            style={{ background: ZONE_COLORS.danger, color: '#fff' }}
            className={css({
              flex: 2,
              border: 'none',
              borderRadius: '8px',
              fontSize: 'sm',
              fontWeight: 'bold',
              paddingY: '10px',
              cursor: 'pointer',
              _disabled: { opacity: 0.6, cursor: 'not-allowed' },
            })}
          >
            {busy ? 'Exiting…' : 'Exit full position now?'}
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="safe-exit-arm"
          onClick={() => setConfirming(true)}
          style={{ background: ZONE_COLORS.danger, color: '#fff' }}
          className={css({
            border: 'none',
            borderRadius: '8px',
            fontSize: 'md',
            fontWeight: 'bold',
            paddingY: '12px',
            cursor: 'pointer',
            animation: 'dangerPulse 2.4s ease-in-out infinite',
            _hover: { opacity: 0.92 },
          })}
        >
          SAFE-EXIT
        </button>
      )}
      {!result && (
        <span className={css({ color: 'github.textMuted' })} style={{ fontSize: '10px' }}>
          Works independently of Claude — closes the live position directly.
        </span>
      )}
    </section>
  );
}
