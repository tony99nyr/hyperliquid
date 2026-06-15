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
  },
  jsxFramework: 'react',
});
