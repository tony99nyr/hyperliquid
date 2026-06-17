import { defineConfig } from '@pandacss/dev';

export default defineConfig({
  preflight: true,
  logLevel: 'warn',
  include: ['./src/**/*.{js,jsx,ts,tsx}'],
  outdir: 'styled-system',
  theme: {
    extend: {
      tokens: {
        colors: {
          // GitHub-dark palette (shared with vendored MiniChart styling)
          github: {
            bg: { value: '#0d1117' },
            bgSecondary: { value: '#161b22' },
            border: { value: '#30363d' },
            borderSubtle: { value: '#21262d' },
            text: { value: '#c9d1d9' },
            textBright: { value: '#e6edf3' },
            textMuted: { value: '#7d8590' },
            link: { value: '#58a6ff' },
          },
          // Trade health / alert zones
          zone: {
            ok: { value: '#3fb950' },
            warn: { value: '#d29922' },
            danger: { value: '#f85149' },
          },
        },
      },
      keyframes: {
        // Approval-popup entrance: scale up from slightly small + fade in.
        popupIn: {
          '0%': { opacity: '0', transform: 'scale(0.92) translateY(8px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        // Backdrop fade.
        backdropIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        // Safe-Exit "armed" subtle pulse to draw the eye to the panic button.
        dangerPulse: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(248, 81, 73, 0.5)' },
          '50%': { boxShadow: '0 0 0 6px rgba(248, 81, 73, 0)' },
        },
      },
    },
  },
  globalCss: {
    'html, body': {
      maxWidth: '100vw',
      overflowX: 'hidden',
      bg: '#0d1117',
      color: '#c9d1d9',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
    },
    '*': { boxSizing: 'border-box' },
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
