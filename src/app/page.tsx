import { css } from '@styled-system/css';
import { getTradingMode } from '@/lib/env/mode';

/**
 * Landing page. The live cockpit (Phase 1) will live at /cockpit behind the
 * admin PIN. This placeholder confirms the scaffold deploys and surfaces the
 * current trading mode so a paper/live misconfiguration is obvious at a glance.
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
        gap: '12px',
        padding: '24px',
      })}
    >
      <h1 className={css({ fontSize: '2xl', fontWeight: 'bold', color: 'github.textBright' })}>
        HL Cockpit
      </h1>
      <p className={css({ color: 'github.textMuted', textAlign: 'center', maxWidth: '480px' })}>
        Human + Claude collaborative trading cockpit for Hyperliquid. The live cockpit ships in
        Phase 1.
      </p>
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
