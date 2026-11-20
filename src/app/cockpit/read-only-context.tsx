'use client';

/**
 * Read-only (viewer) flag for the cockpit UI. The RSC page sets it from the
 * session role. Components read it to hide action controls.
 *
 * This is a courtesy only. The server is the real control: every mutating route
 * calls verifyAdminAuth, which refuses a viewer session.
 */

import { createContext, useContext } from 'react';

const ReadOnlyContext = createContext(false);

export const ReadOnlyProvider = ReadOnlyContext.Provider;

/** True when the signed-in user is a read-only viewer. */
export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}
