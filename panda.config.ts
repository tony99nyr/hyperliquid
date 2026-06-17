import { defineConfig } from '@pandacss/dev';

export default defineConfig({
  preflight: true,
  logLevel: 'warn',
  include: ['./src/**/*.{js,jsx,ts,tsx}'],
  outdir: 'styled-system',
  theme: {
    extend: {
      tokens: {
        fonts: {
          // HL Cockpit design system (design handoff): IBM Plex Mono for all
          // data/numbers (apply `tabular-nums` at the call site so ticking
          // values don't reflow) + IBM Plex Sans for UI labels/buttons.
          mono: {
            value:
              "var(--font-plex-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          },
          // UI labels & buttons (the trading-terminal look). Token name kept as
          // `label` for back-compat with existing call sites.
          label: {
            value:
              "var(--font-plex-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
          },
          // Body / UI sans (alias of label — IBM Plex Sans).
          sans: {
            value:
              "var(--font-plex-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
          },
        },
        colors: {
          // HL COCKPIT design tokens (design handoff). The `github.*` namespace
          // is retained as the codebase-wide alias but now carries the cockpit
          // palette so every island re-skins consistently from one place.
          //   bg #080a0f · bars/panel #0b0e15/#10141c · focal #11161f
          //   text #e8ebf2 · secondary #cdd4e0 · muted #8b95a6 · faint #586273
          github: {
            bg: { value: '#080a0f' }, // page void
            bgSecondary: { value: '#10141c' }, // panel surface
            border: { value: 'rgba(255,255,255,0.07)' }, // card borders
            borderSubtle: { value: 'rgba(255,255,255,0.06)' }, // inner dividers
            text: { value: '#cdd4e0' }, // secondary text
            textBright: { value: '#e8ebf2' }, // primary text
            textMuted: { value: '#8b95a6' }, // muted labels
            link: { value: '#5b8cff' }, // accent / MA20 / selection
          },
          // Cockpit surface layers (named for the design handoff).
          cockpit: {
            void: { value: '#080a0f' },
            bar: { value: '#0b0e15' }, // top/bottom bars
            panel: { value: '#10141c' }, // most cards
            focal: { value: '#11161f' }, // Open Positions, stat cards
            inset: { value: '#0a0d13' }, // inputs, summary boxes
            row: { value: '#0c1017' }, // position rows, mid-book
            navIdle: { value: '#0e131c' }, // nav/timeframe container
            navActive: { value: '#1c2536' }, // active nav/timeframe pill
            button: { value: '#161c27' }, // secondary buttons
            faint: { value: '#586273' }, // captions/meta/axis
            accent: { value: '#5b8cff' },
            safeExit: { value: '#e23a4d' }, // bright exit CTA
            darkText: { value: '#0a0d13' }, // text on bright buttons
          },
          // Trade health / alert zones — remapped to the cockpit semantic palette.
          //   up/long/profit #19c98a · down/short/loss #f24d5e · warn/MA50 #d9a441
          zone: {
            ok: { value: '#19c98a' },
            warn: { value: '#d9a441' },
            danger: { value: '#f24d5e' },
          },
        },
      },
      keyframes: {
        // P&L hero flash on value update (green/red tint pulse). Applied via an
        // inline keyed re-mount so the flash retriggers each tick.
        flashUp: {
          '0%': { backgroundColor: 'rgba(63, 185, 80, 0.22)' },
          '100%': { backgroundColor: 'rgba(63, 185, 80, 0)' },
        },
        flashDown: {
          '0%': { backgroundColor: 'rgba(248, 81, 73, 0.22)' },
          '100%': { backgroundColor: 'rgba(248, 81, 73, 0)' },
        },
        // Approval / exit modal entrance (design handoff popIn): scale .97 +
        // translateY 8px, fade in. 200ms cubic-bezier(.2,.8,.2,1) at call site.
        popupIn: {
          '0%': { opacity: '0', transform: 'scale(0.97) translateY(8px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        // Backdrop fade (150ms).
        backdropIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        // Trader drawer slide-in from the right (translateX 24px).
        slideIn: {
          '0%': { opacity: '0', transform: 'translateX(24px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        // Mobile bottom-sheet slide-up.
        sheetUp: {
          '0%': { transform: 'translateY(100%)' },
          '100%': { transform: 'translateY(0)' },
        },
        // Live-dot pulse (opacity 1 ↔ .35, 2s).
        livePulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        // Safe-Exit "armed" subtle pulse to draw the eye to the panic button.
        dangerPulse: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(226, 58, 77, 0.5)' },
          '50%': { boxShadow: '0 0 0 6px rgba(226, 58, 77, 0)' },
        },
      },
    },
  },
  globalCss: {
    'html, body': {
      maxWidth: '100vw',
      overflowX: 'hidden',
      bg: '#080a0f',
      color: '#e8ebf2',
      fontFamily:
        "var(--font-plex-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    },
    '::selection': { background: 'rgba(91,140,255,0.3)' },
    '*': { boxSizing: 'border-box' },
    // A11y: a clearly visible keyboard-focus ring on the dark chrome. Mouse
    // clicks don't trigger :focus-visible, so this only shows for keyboard/AT
    // users (tabs, CoinSelector, buttons, links). Token-based accent ring.
    'a:focus-visible, button:focus-visible, select:focus-visible, [tabindex]:focus-visible, [role="button"]:focus-visible':
      {
        outline: '2px solid token(colors.github.link)',
        outlineOffset: '2px',
        borderRadius: '4px',
      },
    // Suppress the default (non-keyboard) outline so the focus-visible ring is
    // the single, intentional focus affordance.
    ':focus:not(:focus-visible)': { outline: 'none' },
    // A11y: vestibular users opt out of motion. Remove the cockpit's entrance +
    // pulse animations (popupIn, backdropIn, and the Safe-Exit dangerPulse, which
    // otherwise loops a red glow forever). The universal selector catches all
    // three regardless of which utility class applied them.
    '@media (prefers-reduced-motion: reduce)': {
      '*, *::before, *::after': {
        animation: 'none !important',
        transitionDuration: '0.001ms !important',
      },
    },
  },
  jsxFramework: 'react',
});
