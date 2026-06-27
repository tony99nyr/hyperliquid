'use client';

/**
 * BottomTabBar — the PHONE-ONLY bottom navigation (design handoff
 * 11/12/13-mobile). Three tabs (Cockpit / Traders / Performance) with line
 * icons; the active tab is accented (#5b8cff) and announced via
 * `aria-current="page"`. Hidden at `lg`+ (desktop uses the TopBar segmented nav,
 * where Traders lives inside the cockpit grid as the left rail).
 *
 * This is the mobile view switch — the single stateful control on the phone
 * surface. It changes WHICH island stack is visible, never trading mode.
 */

import { css } from '@styled-system/css';

export type MobileTab = 'cockpit' | 'traders' | 'ladders' | 'performance' | 'scout';

export interface BottomTabBarProps {
  tab: MobileTab;
  onTabChange: (t: MobileTab) => void;
}

const TABS: { key: MobileTab; label: string; icon: React.ReactNode }[] = [
  { key: 'cockpit', label: 'Cockpit', icon: <BarsIcon /> },
  { key: 'traders', label: 'Traders', icon: <ListIcon /> },
  { key: 'ladders', label: 'Ladders', icon: <LadderIcon /> },
  { key: 'performance', label: 'Performance', icon: <TrendIcon /> },
  { key: 'scout', label: 'Scout', icon: <BotIcon /> },
];

function LadderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="6" y1="2" x2="6" y2="16" />
      <line x1="12" y1="2" x2="12" y2="16" />
      <line x1="6" y1="5" x2="12" y2="5" />
      <line x1="6" y1="9" x2="12" y2="9" />
      <line x1="6" y1="13" x2="12" y2="13" />
    </svg>
  );
}

export default function BottomTabBar({ tab, onTabChange }: BottomTabBarProps) {
  return (
    <nav
      data-testid="mobile-tab-bar"
      aria-label="Mobile navigation"
      className={css({
        display: { base: 'flex', lg: 'none' },
        flex: 'none',
        alignItems: 'stretch',
        height: '58px',
        borderTop: '1px solid token(colors.github.border)',
        bg: 'cockpit.bar',
        paddingBottom: 'env(safe-area-inset-bottom)',
        // Pin to the viewport bottom on mobile so a tall scrolling surface can't
        // push the nav (Cockpit/Traders/Performance icons) below the fold — the
        // "icons sometimes don't render" bug was really the bar scrolled off-screen.
        position: { base: 'sticky', lg: 'static' },
        bottom: 0,
        zIndex: 20,
      })}
    >
      {TABS.map((t) => {
        const active = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            data-testid={`mobile-tab-${t.key}`}
            data-active={active}
            aria-current={active ? 'page' : undefined}
            onClick={() => onTabChange(t.key)}
            style={{ color: active ? '#5b8cff' : '#9aa4b5' }}
            className={css({
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'sans',
              fontSize: '10px',
              fontWeight: active ? 'semibold' : 'medium',
              letterSpacing: '0.02em',
            })}
          >
            {t.icon}
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}

function BarsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <rect x="2" y="9" width="3" height="6" rx="1" fill="currentColor" />
      <rect x="7.5" y="5" width="3" height="10" rx="1" fill="currentColor" />
      <rect x="13" y="2" width="3" height="13" rx="1" fill="currentColor" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="3" y1="5" x2="15" y2="5" />
      <line x1="3" y1="9" x2="15" y2="9" />
      <line x1="3" y1="13" x2="15" y2="13" />
    </svg>
  );
}

function TrendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2,12 6,8 9,10 16,3" />
      <polyline points="12,3 16,3 16,7" />
    </svg>
  );
}

function BotIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="6" width="11" height="8" rx="2" />
      <line x1="9" y1="3" x2="9" y2="6" />
      <circle cx="9" cy="3" r="0.8" fill="currentColor" />
      <line x1="7" y1="10" x2="7" y2="10.5" />
      <line x1="11" y1="10" x2="11" y2="10.5" />
    </svg>
  );
}
