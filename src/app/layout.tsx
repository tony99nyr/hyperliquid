import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import './globals.css';

/**
 * HL Cockpit typography (design handoff — wired through Panda tokens, see
 * panda.config.ts):
 *   - IBM Plex Mono for ALL data/numbers (tabular-nums; no jitter on ticking values).
 *   - IBM Plex Sans for UI labels & buttons.
 * NOT Inter/Roboto/system. Exposed as CSS variables consumed by `fonts.mono` /
 * `fonts.label` / `fonts.sans` token values.
 *
 * The font files live in `./fonts` (latin subset, OFL-1.1) and load through
 * `next/font/local`, so the build does not fetch from Google Fonts.
 */
const plexMono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-plex-mono',
});

const plexSans = localFont({
  src: [
    { path: './fonts/ibm-plex-sans-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-600-normal.woff2', weight: '600', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-700-normal.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-plex-sans',
});

export const metadata: Metadata = {
  title: 'HL Cockpit',
  description: 'Human + Claude collaborative trading cockpit for Hyperliquid (paper-first).',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${plexMono.variable} ${plexSans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
