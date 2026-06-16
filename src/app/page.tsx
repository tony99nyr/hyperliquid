import Link from 'next/link';
import { css } from '@styled-system/css';
import { getTradingMode } from '@/lib/env/mode';

/**
 * Landing page. The live cockpit lives at /cockpit behind the admin PIN.
 * Phase 1 has shipped — this is a working paper-first cockpit — so this page
 * routes straight into it and surfaces the current trading mode so a
 * paper/live misconfiguration is obvious at a glance.
 */
export default function Home() {
  const mode = getTradingMode();
  return (
    <main
      className={css({
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '16px',
        padding: '24px',
      })}
    >
      <h1 className={css({ fontSize: '2xl', fontWeight: 'bold', color: 'github.textBright' })}>
        HL Cockpit
      </h1>
      <p className={css({ color: 'github.textMuted', textAlign: 'center', maxWidth: '480px' })}>
        Human + Claude collaborative trading cockpit for Hyperliquid. The live paper cockpit is up
        and running — open it to track the leader, manage the session, and review trades.
      </p>
      <Link
        href="/cockpit"
        className={css({
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: 'md',
          fontWeight: 'semibold',
          padding: '10px 20px',
          borderRadius: '8px',
          bg: 'github.bgSecondary',
          color: 'github.link',
          border: '1px solid token(colors.github.border)',
          textDecoration: 'none',
          transition: 'background 0.15s ease, border-color 0.15s ease',
          _hover: {
            bg: 'github.border',
            borderColor: 'github.link',
          },
        })}
      >
        Open the cockpit →
      </Link>
      <span
        className={css({
          fontSize: 'sm',
          fontFamily: 'mono',
          padding: '4px 10px',
          borderRadius: '6px',
          border: '1px solid token(colors.github.border)',
          color: mode === 'live' ? 'zone.danger' : 'zone.ok',
        })}
      >
        TRADING_MODE: {mode}
      </span>
    </main>
  );
}
