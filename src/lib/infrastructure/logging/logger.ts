/**
 * Minimal logger (vendored-compatible).
 *
 * iamrossi's logger wired Discord/Redis/notification sinks. The cockpit only
 * needs the two helpers the vendored code (hyperliquid-info-service, auth)
 * actually imports: `extractErrorMessage` and `logError`. Console-only here —
 * the heavy sinks were intentionally stripped for Phase 0.
 */

/** Normalize any thrown value to a string message. */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Log an error to stderr (kept visible under the test console suppression). */
export function logError(message: string, err?: unknown): void {
  if (err !== undefined) {
    console.error(`[error] ${message}`, extractErrorMessage(err));
  } else {
    console.error(`[error] ${message}`);
  }
}
