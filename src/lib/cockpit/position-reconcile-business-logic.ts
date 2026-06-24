/**
 * PURE position reconciliation — the cockpit's `positions` table is built only from
 * fills the cockpit itself executes, so a position closed/changed DIRECTLY on
 * Hyperliquid (manual app close, partial fill, liquidation) leaves the cockpit
 * showing a stale/phantom position. This computes the updates that bring the cockpit
 * BACK IN LINE with the real account: flatten anything HL no longer holds, resync any
 * size/side that drifted. No I/O — the service feeds it cockpit rows + HL positions.
 *
 * Only EXISTING cockpit positions are reconciled (brought DOWN to HL truth). An HL
 * position the cockpit has no row for is left alone (no session to attach it to).
 *
 * SAFETY: the caller MUST only invoke this with a FRESH (non-stale) HL read — a
 * transient HL error returning empty positions must never be allowed to wrongly
 * flatten real positions. That guard lives in the service.
 */

export type PositionSide = 'long' | 'short' | 'flat';

export interface CockpitPos {
  sessionId: string;
  coin: string;
  side: PositionSide;
  sz: number;
  avgEntryPx: number;
}

export interface HlPos {
  coin: string;
  /** Signed size (negative = short, 0 = flat). */
  szi: number;
  entryPx: number | null;
}

export interface ReconcileAction {
  sessionId: string;
  coin: string;
  /** The state to WRITE to the cockpit row so it mirrors HL. */
  target: { side: PositionSide; sz: number; avgEntryPx: number };
  reason: 'flatten' | 'resync';
  /** Size of the divergence in USD (for logging / observability). */
  deltaUsd: number;
}

/** Divergence below this notional is treated as in-sync (dust / floating-point noise
 *  / sub-lot residual HL rounds away). Matches the position fold's dust floor. */
export const RECONCILE_MIN_DELTA_USD = 1;

const signedOf = (side: PositionSide, sz: number): number => (side === 'long' ? sz : side === 'short' ? -sz : 0);

/**
 * Compute the reconcile actions to make each cockpit position match HL. Skips
 * positions already in sync (within the dust floor). Pure + deterministic.
 */
export function reconcilePositions(cockpit: CockpitPos[], hl: HlPos[]): ReconcileAction[] {
  const hlByCoin = new Map<string, HlPos>();
  for (const p of hl) hlByCoin.set(p.coin.trim().toUpperCase(), p);

  const actions: ReconcileAction[] = [];
  for (const c of cockpit) {
    if (c.side === 'flat' || c.sz <= 0) continue; // already flat — nothing to reconcile
    const coin = c.coin.trim().toUpperCase();
    const real = hlByCoin.get(coin);
    const realSzi = real?.szi ?? 0;
    const cockpitSigned = signedOf(c.side, c.sz);
    // Price the divergence off the most reliable px available (HL entry, else cockpit).
    const px = (real?.entryPx ?? c.avgEntryPx) || c.avgEntryPx || 0;
    const deltaUsd = Math.abs(cockpitSigned - realSzi) * px;
    if (deltaUsd < RECONCILE_MIN_DELTA_USD) continue; // in sync

    if (realSzi === 0) {
      // HL holds nothing for this coin → the cockpit row is stale: flatten it.
      actions.push({ sessionId: c.sessionId, coin: c.coin, target: { side: 'flat', sz: 0, avgEntryPx: 0 }, reason: 'flatten', deltaUsd });
    } else {
      // Size/side drifted (missed partial fill / manual change) → mirror HL exactly.
      actions.push({
        sessionId: c.sessionId,
        coin: c.coin,
        target: { side: realSzi > 0 ? 'long' : 'short', sz: Math.abs(realSzi), avgEntryPx: real?.entryPx ?? c.avgEntryPx },
        reason: 'resync',
        deltaUsd,
      });
    }
  }
  return actions;
}
