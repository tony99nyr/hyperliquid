'use client';

/**
 * GettingStarted — cold-start card shown in the cockpit when there is no active
 * session. The cockpit is a LIVE MIRROR of a Claude-driven PAPER trading
 * session: a human drives it from a Claude Code session (skills in this repo
 * write to Supabase → realtime → these panels), NOT from the web UI. So the
 * empty state must teach that flow rather than just say "no session".
 */

import Link from 'next/link';
import { css } from '@styled-system/css';

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

const STEPS: { body: React.ReactNode }[] = [
  {
    body: (
      <>
        This cockpit <strong>live-mirrors a Claude-driven paper trading session</strong> — you drive
        it from a Claude Code session, not from this page.
      </>
    ),
  },
  {
    body: (
      <>
        Open a Claude Code session in the cockpit repo (<code className={css({ fontFamily: 'mono' })}>/g/hyperliquid</code>)
        so its skills load.
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
        Run <Skill name="open-position" /> to open a paper trade — this creates the session, and the
        cockpit will start live-tracking the position, health, P&amp;L, hypotheses, and analysis
        stream.
      </>
    ),
  },
];

export default function GettingStarted() {
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
          className={css({
            fontSize: 'xs',
            fontFamily: 'mono',
            padding: '2px 8px',
            borderRadius: '6px',
            border: '1px solid token(colors.github.border)',
            color: 'zone.ok',
          })}
        >
          PAPER mode · no real funds
        </span>
      </div>

      <p className={css({ fontSize: 'sm', color: 'github.textMuted', lineHeight: '1.5' })}>
        No active session yet. The cockpit comes alive once you open a paper position from a Claude
        Code session — here is the flow:
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
        {STEPS.map((step, i) => (
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
