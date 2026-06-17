import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { JetBrains_Mono, Archivo } from 'next/font/google';
import './globals.css';

/**
 * Trading-desk typography (wired through Panda tokens — see panda.config.ts):
 *   - JetBrains Mono for ALL numerics (tabular-nums; no jitter on ticking values).
 *   - Archivo for small UPPERCASE letter-spaced labels.
 * NOT Inter/Roboto/system. Exposed as CSS variables consumed by `fonts.mono` /
 * `fonts.label` token values.
 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

const archivo = Archivo({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-archivo',
});

export const metadata: Metadata = {
  title: 'HL Cockpit',
  description: 'Human + Claude collaborative trading cockpit for Hyperliquid (paper-first).',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${jetbrainsMono.variable} ${archivo.variable}`}>
      <body>{children}</body>
    </html>
  );
}
