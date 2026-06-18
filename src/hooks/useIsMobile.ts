'use client';

/**
 * useIsMobile — hydration-safe viewport-width breakpoint. Returns false during
 * SSR + the first client render (so server and client markup match — the desktop
 * shell), then syncs to the real viewport after mount and tracks resizes.
 *
 * Drives the cockpit's mobile vs desktop SHELL split (bottom tab bar + stacked
 * phone surface vs the three-column terminal). The `lg` breakpoint (1024px)
 * mirrors the Panda `lg` token the layouts already switch on, so JS-driven
 * mounting and CSS-driven styling agree.
 */

import { useEffect, useState } from 'react';

/** Matches Panda's `lg` token (1024px). Below this width = mobile/tablet shell. */
const MOBILE_MAX_WIDTH = 1023;

export function useIsMobile(maxWidth: number = MOBILE_MAX_WIDTH): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [maxWidth]);

  return isMobile;
}
