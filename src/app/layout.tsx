import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import './globals.css';

/**
 * HL Cockpit typography (design handoff — wired through Panda tokens, see
 * panda.config.ts):
 *   - IBM Plex Mono for ALL data/numbers (tabular-nums; no jitter on ticking values).
 *   - IBM Plex Sans for UI labels & buttons.
 * NOT Inter/Roboto/system. Exposed as CSS variables consumed by `fonts.mono` /
 * `fonts.label` / `fonts.sans` token values.
 */
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-plex-mono',
});

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
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
