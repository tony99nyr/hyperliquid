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
  /** Epoch ms the cockpit row was last written. Used by the freshness guard to
   *  AVOID reconciling a just-opened position against a cache-lagged HL read. */
  updatedAtMs?: number;
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
 *  / sub-lot residual HL rounds away). Matches the position fold's dust floor. Applies
 *  to RESYNC only — a coin HL doesn't hold at all is always flattened (even sub-$1). */
export const RECONCILE_MIN_DELTA_USD = 1;

/** A row written more recently than this is NOT reconciled: HL's clearinghouse read is
 *  cache-lagged (~25s) and a fresh fill takes a moment to settle on HL, so a just-opened
 *  position could otherwise be wrongly flattened against a stale-but-fresh-marked read. */
export const RECONCILE_MIN_ROW_AGE_MS = 90_000;

const signedOf = (side: PositionSide, sz: number): number => (side === 'long' ? sz : side === 'short' ? -sz : 0);

export interface ReconcileOpts {
  /** Wall clock (epoch ms); the freshness guard compares it to each row's updatedAtMs. */
  nowMs?: number;
  /** Skip rows younger than this (default RECONCILE_MIN_ROW_AGE_MS). */
  minRowAgeMs?: number;
}

/**
 * Compute the reconcile actions to make each cockpit position match HL. Pure +
 * deterministic. Skips rows in sync (resync dust floor) AND rows too FRESH to trust
 * against a cache-lagged HL read (the just-opened-position race).
 */
export function reconcilePositions(cockpit: CockpitPos[], hl: HlPos[], opts: ReconcileOpts = {}): ReconcileAction[] {
  const nowMs = opts.nowMs;
  const minRowAgeMs = opts.minRowAgeMs ?? RECONCILE_MIN_ROW_AGE_MS;

  const hlByCoin = new Map<string, HlPos>();
  for (const p of hl) hlByCoin.set(p.coin.trim().toUpperCase(), p);

  const actions: ReconcileAction[] = [];
  for (const c of cockpit) {
    if (c.side === 'flat' || c.sz <= 0) continue; // already flat — nothing to reconcile
    // FRESHNESS GUARD: a just-written row may be mid-settlement on HL / behind the
    // clearinghouse cache — don't reconcile it (avoids flattening a real new position).
    if (nowMs !== undefined && c.updatedAtMs !== undefined && nowMs - c.updatedAtMs < minRowAgeMs) continue;

    const coin = c.coin.trim().toUpperCase();
    const real = hlByCoin.get(coin);
    const realSzi = real?.szi ?? 0;
    const cockpitSigned = signedOf(c.side, c.sz);

    if (realSzi === 0) {
      // HL holds NOTHING for this coin → the cockpit row is stale. Flatten ALWAYS —
      // independent of the dust floor / px (a phantom open must clear even at px 0).
      const px = (real?.entryPx ?? c.avgEntryPx) || 0;
      actions.push({ sessionId: c.sessionId, coin: c.coin, target: { side: 'flat', sz: 0, avgEntryPx: 0 }, reason: 'flatten', deltaUsd: Math.abs(cockpitSigned) * px });
      continue;
    }
    if (!real) continue; // unreachable (realSzi !== 0 ⇒ real defined) — narrows the type

    // HL still holds it — only RESYNC when size/side drifted beyond the dust floor.
    const px = (real.entryPx ?? c.avgEntryPx) || c.avgEntryPx || 0;
    const deltaUsd = Math.abs(cockpitSigned - realSzi) * px;
    if (deltaUsd < RECONCILE_MIN_DELTA_USD) continue; // in sync (within dust)
    actions.push({
      sessionId: c.sessionId,
      coin: c.coin,
      target: { side: realSzi > 0 ? 'long' : 'short', sz: Math.abs(realSzi), avgEntryPx: real.entryPx ?? c.avgEntryPx },
      reason: 'resync',
      deltaUsd,
    });
  }
  return actions;
}
