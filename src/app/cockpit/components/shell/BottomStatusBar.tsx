'use client';

/**
 * BottomStatusBar (design handoff, 34px) — connected dot · leader address ·
 * mirror on/off · mode · latency · live clock. A thin status footer; all values
 * are live readouts (no controls). The clock ticks client-side every second.
 */

import { useEffect, useState } from 'react';
import { css } from '@styled-system/css';
import type { TradingMode } from '@/types/fill';

export interface BottomStatusBarProps {
  connected: boolean;
  leaderAddress: string | null;
  mode: TradingMode;
  /** Realtime round-trip latency estimate (ms), if known. */
  latencyMs?: number | null;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function BottomStatusBar({ connected, leaderAddress, mode, latencyMs }: BottomStatusBarProps) {
  const [clock, setClock] = useState('');
  useEffect(() => {
    const tick = () => setClock(`${new Date().toLocaleTimeString('en-US', { hour12: false })} UTC`);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const mirrorOn = leaderAddress !== null;

  return (
    <footer
      data-testid="cockpit-statusbar"
      className={css({
        display: 'flex',
        alignItems: 'center',
        gap: { base: '12px', md: '18px' },
        paddingX: '18px',
        height: '34px',
        flex: 'none',
        borderTop: '1px solid token(colors.github.border)',
        bg: 'cockpit.bar',
        fontFamily: 'mono',
        fontSize: '10.5px',
        color: 'cockpit.faint',
        overflowX: 'auto',
        whiteSpace: 'nowrap',
      })}
    >
      <span className={css({ display: 'flex', alignItems: 'center', gap: '6px' })}>
        <span
          aria-hidden
          style={{ background: connected ? '#19c98a' : '#586273' }}
          className={css({ width: '6px', height: '6px', borderRadius: '50%', animation: connected ? 'livePulse 2s infinite' : 'none' })}
        />
        {connected ? 'connected' : 'offline'}
      </span>
      <span data-testid="status-leader">
        leader {leaderAddress ? shortAddr(leaderAddress) : 'none'}
      </span>
      <span>
        mirror <span style={{ color: mirrorOn ? '#5b8cff' : '#586273' }}>{mirrorOn ? 'on' : 'off'}</span>
      </span>
      <span className={css({ flex: 1 })} />
      <span data-testid="status-mode">{mode === 'live' ? 'LIVE TRADING' : 'PAPER MODE'}</span>
      <span className={css({ display: { base: 'none', sm: 'inline' } })}>
        latency <span style={{ color: '#19c98a' }}>{latencyMs == null ? '—' : `${Math.round(latencyMs)}ms`}</span>
      </span>
      <span data-testid="status-clock" style={{ fontFeatureSettings: '"tnum"' }}>{clock}</span>
    </footer>
  );
}
