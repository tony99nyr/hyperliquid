'use client';

/**
 * GettingStarted — cold-start card shown in the cockpit when there is no active
 * session. MODE-AWARE: in paper it teaches the (no-real-funds) flow; in LIVE it
 * must loudly say REAL FUNDS — never "no real funds" when TRADING_MODE=live.
 *
 * You can open a position either from a Claude Code session (the skills here) OR
 * directly in the cockpit via "New Position" / "Mirror this". The first fill
 * creates the session and the cockpit starts live-tracking it.
 */

import Link from 'next/link';
import { css } from '@styled-system/css';
import type { TradingMode } from '@/types/fill';
import { ZONE_COLORS } from './panel-styles';

/** Inline monospace skill name. */
function Skill({ name }: { name: string }) {
  return (
    <code
      className={css({
        fontFamily: 'mono',
        fontSize: '0.95em',
        bg: 'github.bg',
        color: 'github.link',
        border: '1px solid token(colors.github.borderSubtle)',
        borderRadius: '4px',
        padding: '1px 6px',
      })}
    >
      {name}
    </code>
  );
}

function buildSteps(live: boolean): { body: React.ReactNode }[] {
  const tradeWord = live ? 'trade' : 'paper trade';
  return [
    {
      body: (
        <>
          This cockpit <strong>live-mirrors your trading session</strong>. Open a position from a
          Claude Code session (the skills below) <em>or</em> directly here with{' '}
          <strong>New Position</strong> / <strong>Mirror this</strong>.
        </>
      ),
    },
    {
      body: (
        <>
          Open a Claude Code session in the cockpit repo (<code className={css({ fontFamily: 'mono' })}>/g/hyperliquid</code>)
          so its skills load — or just use the cockpit&apos;s own controls.
        </>
      ),
    },
    {
      body: (
        <>
          Run <Skill name="analyze-traders" /> to find and grade a Hyperliquid trader to follow.
        </>
      ),
    },
    {
      body: (
        <>
          Run <Skill name="analyze-market-timeframes" /> to read the setup across 1d / 8h / 1h / 15m.
        </>
      ),
    },
    {
      body: (
        <>
          Run <Skill name="open-position" /> (or click <strong>New Position</strong>) to open a {tradeWord} —
          this creates the session, and the cockpit starts live-tracking the position, health, P&amp;L,
          hypotheses, and analysis stream.
        </>
      ),
    },
  ];
}

export default function GettingStarted({ mode }: { mode: TradingMode }) {
  const live = mode === 'live';
  return (
    <section
      data-testid="getting-started"
      className={css({
        bg: 'github.bgSecondary',
        border: '1px solid token(colors.github.border)',
        borderRadius: '8px',
        padding: { base: '16px', md: '20px' },
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      })}
    >
      <div className={css({ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px' })}>
        <h2 className={css({ fontSize: 'lg', fontWeight: 'bold', color: 'github.textBright' })}>
          Getting started
        </h2>
        <span
          data-testid="getting-started-mode"
          data-mode={mode}
          style={{ color: live ? ZONE_COLORS.danger : ZONE_COLORS.ok, borderColor: live ? ZONE_COLORS.danger : undefined }}
          className={css({
            fontSize: 'xs',
            fontFamily: 'mono',
            fontWeight: live ? 'bold' : 'normal',
            padding: '2px 8px',
            borderRadius: '6px',
            border: '1px solid token(colors.github.border)',
          })}
        >
          {live ? '● LIVE — REAL FUNDS AT RISK' : 'PAPER mode · no real funds'}
        </span>
      </div>

      <p className={css({ fontSize: 'sm', color: 'github.textMuted', lineHeight: '1.5' })}>
        {live ? (
          <>
            No active session yet.{' '}
            <strong style={{ color: ZONE_COLORS.danger }}>This is a LIVE account — orders use real funds.</strong>{' '}
            Open a position to bring the cockpit alive — here is the flow:
          </>
        ) : (
          <>
            No active session yet. The cockpit comes alive once you open a paper position — here is the
            flow:
          </>
        )}
      </p>

      <ol
        className={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          listStyle: 'none',
          margin: 0,
          padding: 0,
        })}
      >
        {buildSteps(live).map((step, i) => (
          <li
            key={i}
            className={css({ display: 'flex', gap: '10px', alignItems: 'flex-start' })}
          >
            <span
              className={css({
                flexShrink: 0,
                width: '22px',
                height: '22px',
                borderRadius: '50%',
                bg: 'github.bg',
                border: '1px solid token(colors.github.border)',
                color: 'github.textBright',
                fontSize: 'xs',
                fontWeight: 'bold',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              })}
            >
              {i + 1}
            </span>
            <span className={css({ fontSize: 'sm', color: 'github.text', lineHeight: '1.5' })}>
              {step.body}
            </span>
          </li>
        ))}
      </ol>

      <Link
        href="/"
        className={css({
          alignSelf: 'flex-start',
          fontSize: 'sm',
          fontWeight: 'semibold',
          color: 'github.link',
          textDecoration: 'none',
          padding: '6px 12px',
          borderRadius: '6px',
          border: '1px solid token(colors.github.border)',
          transition: 'background 0.15s ease, border-color 0.15s ease',
          _hover: { bg: 'github.border', borderColor: 'github.link' },
        })}
      >
        ← Back to overview
      </Link>
    </section>
  );
}
