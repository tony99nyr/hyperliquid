'use client';

/**
 * Page activity tracking — the "stop polling when nobody's there" seam.
 *
 * A hidden tab was already handled (document.hidden checks), but a VISIBLE tab on an
 * unattended monitor polled Vercel all night. This module tracks the last user input
 * (pointer / key / scroll / touch) with ONE set of module-level listeners, and pollers
 * ask `isPageActive(idleMs)` before each fetch: hidden OR idle past the window ⇒ skip.
 * Any input instantly makes the page active again (the next tick resumes; callers can
 * also subscribe to `onActivityResume` for an immediate refresh).
 */

/** Default idle window: no input for this long ⇒ polls pause. */
export const DEFAULT_IDLE_MS = 10 * 60_000;

let lastInputAt = Date.now();
let installed = false;
const resumeListeners = new Set<() => void>();

function markInput(): void {
  const wasIdle = Date.now() - lastInputAt > DEFAULT_IDLE_MS;
  lastInputAt = Date.now();
  if (wasIdle) for (const fn of resumeListeners) fn();
}

function ensureInstalled(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  // Passive + capture: never affects app handlers; counts all interaction as presence.
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    document.addEventListener(ev, markInput, { passive: true, capture: true });
  }
}

/** PURE decision (unit-tested): active = visible AND input within the idle window. */
export function pageIsActive(now: number, lastInput: number, hidden: boolean, idleMs: number): boolean {
  if (hidden) return false;
  return now - lastInput <= idleMs;
}

/** Should a poller fetch right now? Installs the listeners lazily on first use. */
export function isPageActive(idleMs: number = DEFAULT_IDLE_MS): boolean {
  if (typeof document === 'undefined') return false;
  ensureInstalled();
  return pageIsActive(Date.now(), lastInputAt, document.hidden, idleMs);
}

/** Fire `fn` when the user returns from idle (for an immediate refresh). Returns an
 *  unsubscribe. */
export function onActivityResume(fn: () => void): () => void {
  ensureInstalled();
  resumeListeners.add(fn);
  return () => resumeListeners.delete(fn);
}
