'use client';

/**
 * PinGate — the admin-PIN modal shown when /cockpit is opened unauthenticated.
 * Posts the PIN to /api/auth/login (which sets the admin cookie via the vendored
 * auth helpers), then reloads so the RSC gate re-renders the cockpit. No secret
 * ever lives in the client beyond the transient input.
 */

import { useState } from 'react';
import { css } from '@styled-system/css';

export default function PinGate() {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        window.location.reload();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? 'Login failed');
    } catch {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main
      className={css({
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      })}
    >
      <form
        onSubmit={submit}
        data-testid="pin-gate"
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          width: '100%',
          maxWidth: '320px',
          bg: 'github.bgSecondary',
          border: '1px solid token(colors.github.border)',
          borderRadius: '10px',
          padding: '24px',
        })}
      >
        <h1 className={css({ fontSize: 'lg', fontWeight: 'bold', color: 'github.textBright' })}>
          HL Cockpit
        </h1>
        <p className={css({ fontSize: 'sm', color: 'github.textMuted' })}>Enter admin PIN to continue.</p>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="PIN"
          aria-label="Admin PIN"
          className={css({
            bg: 'github.bg',
            border: '1px solid token(colors.github.border)',
            borderRadius: '6px',
            padding: '10px 12px',
            color: 'github.textBright',
            fontFamily: 'mono',
            fontSize: 'md',
            _focus: { outline: '2px solid token(colors.github.link)' },
          })}
        />
        {error && (
          <span data-testid="pin-error" className={css({ fontSize: 'xs', color: 'zone.danger' })}>
            {error}
          </span>
        )}
        <button
          type="submit"
          disabled={submitting || pin.length === 0}
          className={css({
            bg: 'github.link',
            color: '#080a0f',
            fontWeight: 'bold',
            borderRadius: '6px',
            padding: '10px',
            cursor: 'pointer',
            _disabled: { opacity: 0.5, cursor: 'not-allowed' },
          })}
        >
          {submitting ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </main>
  );
}
