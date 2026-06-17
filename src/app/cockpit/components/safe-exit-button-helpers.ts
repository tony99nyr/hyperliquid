/**
 * PURE helpers for the Safe-Exit button (no React/I/O — fixture-tested).
 *
 * The button must clearly tell the operator WHAT will happen when they fire it:
 * use the fresh Claude-authored plan, or — when the plan is stale/absent —
 * market-close the full live position ("Claude offline"). These helpers compute
 * the freshness label so the warning is explicit and unit-tested.
 */

import type { SafeExitPlan } from '@/types/cockpit';

export interface SafeExitStatus {
  /** Short label, e.g. "plan updated 12s ago" or "Claude offline". */
  label: string;
  /** Longer explanation of what firing will do. */
  detail: string;
  /** 'ok' when a fresh plan will be used, 'danger' when the fallback will run. */
  tone: 'ok' | 'danger';
}

/** Human "Ns ago" / "Nm ago" for a millisecond age. */
export function formatAge(ageMs: number): string {
  const s = Math.round(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/**
 * Describe what the Safe-Exit button will do given the current plan + freshness.
 *
 *   fresh plan   → use the Claude-authored exit (tone ok).
 *   stale/absent → market-close the full live position (tone danger,
 *                  "Claude offline").
 */
export function safeExitStatus(
  plan: SafeExitPlan | null,
  fresh: boolean,
  ageMs: number | null,
): SafeExitStatus {
  if (plan && fresh && ageMs != null) {
    return {
      label: `plan updated ${formatAge(ageMs)}`,
      detail: 'Will execute Claude’s current reduce-only exit plan.',
      tone: 'ok',
    };
  }
  return {
    label: 'Claude offline / plan stale',
    detail: 'Will market-close the full position (reduce-only) from the live position.',
    tone: 'danger',
  };
}
