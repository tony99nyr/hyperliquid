/**
 * Scout multi-lane types shared across the server service + client UI. No runtime
 * (no server-only imports), so the cockpit hook/panel can import it freely.
 */

export type LaneKind = 'account' | 'positions' | 'vault' | 'carry';

/** A scored lane card — the account-level scorecard or one strategy lane. */
export interface LaneCard {
  /** Stable lane id: 'ALL' | 'directional' | 'vault:HLP' | 'carry'. */
  lane: string;
  kind: LaneKind;
  netUsd: number;
  realizedUsd: number;
  /** Signed funding (− = carry earned). */
  fundingUsd: number;
  unrealizedUsd: number;
  tradeCount: number;
  winRate: number; // 0–1
  monthlyRunRateUsd: number;
  periodDays: number;
  verdict: string; // kill | continue | graduate
  /** Human one-liner for the breakdown row. */
  label: string;
  openCount: number;
  detail: Record<string, unknown>;
}
