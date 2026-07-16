/**
 * Exchange-fill backfill — PURE. Decides which of HL's own fills are MISSING
 * from the cockpit's `fills` ledger and folds them into insertable candidates.
 *
 * Why this exists: exits that fill on RESTING HL orders (stops, brackets,
 * TP triggers, manual app closes) never pass through `executeIntent`, so the
 * internal ledger under-counts closes — trades look eternally open, win rate
 * and net P&L understate, "today" misses realized exits. The position
 * reconciler fixes the `positions` rows but not the fills history; this module
 * fixes the history itself.
 *
 * Aggregation contract: `executeIntent` books ONE fills row per ORDER
 * (totalSz/avgPx from the HL confirmation), while HL's `userFillsByTime`
 * reports per-fill rows where several partials share one `oid`. To dedupe
 * exactly against both prior executions AND prior backfills, candidates are
 * grouped per oid and aggregated the same way (Σsz, volume-weighted px, Σfee),
 * keyed by `hlOrderId = String(oid)`.
 */

import type { HlFill } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { OrderSide } from '@/types/fill';

/** One missing exchange order, aggregated across its partial fills. */
export interface BackfillCandidate {
  coin: string;
  side: OrderSide;
  /** Volume-weighted average price across the order's fills. */
  px: number;
  /** Total size across the order's fills. */
  sz: number;
  notionalUsd: number;
  feeUsd: number;
  /** True when every fill direction closes (HL `dir` "Close Long"/"Close Short"). */
  reduceOnly: boolean;
  /** Latest fill time of the order — when the order finished executing. */
  filledAt: number;
  hlOrderId: string;
  /** The raw HL fill rows, kept for audit in `hl_raw`. */
  rawRows: Array<Record<string, unknown>>;
}

/** Perp coins only: spot pairs ("PURR/USDC") and spot indices ("@107") are not ours. */
function isPerpCoin(coin: string): boolean {
  return coin.length > 0 && !coin.includes('/') && !coin.startsWith('@');
}

/** A known order whose HL size exceeds what the ledger booked (late partials). */
export interface UnderBookedOrder {
  hlOrderId: string;
  coin: string;
  /** HL size in the window minus the ledger's booked size. */
  deltaSz: number;
}

export interface MissingFillsResult {
  candidates: BackfillCandidate[];
  /** DETECTED, not booked: `fills_hl_order_id_uniq` allows one row per order, so
   *  late partial fills of an already-booked oid cannot be inserted as a second
   *  row. The caller alerts the operator instead — a loud gap beats a silent
   *  double-book (the fold would double-count size and realized P&L forever). */
  underBooked: UnderBookedOrder[];
}

/**
 * Fold HL fills into per-order candidates, dropping every order the ledger
 * already knows (`knownSzByOid` = Σ booked sz per existing `fills.hl_order_id`)
 * and REPORTING known orders whose exchange size outgrew the booked size.
 * Fills with no `oid` are skipped — without the order id there is no exact
 * dedupe key, and inserting a maybe-duplicate is worse than missing a row
 * until the next run surfaces it (HL sends oid on all standard fills).
 */
export function computeMissingFills(
  hlFills: ReadonlyArray<HlFill>,
  knownSzByOid: ReadonlyMap<string, number>,
  sinceMs = 0,
): MissingFillsResult {
  const byOid = new Map<string, HlFill[]>();
  const underBooked: UnderBookedOrder[] = [];
  const seenKnown = new Map<string, { coin: string; sz: number }>();
  for (const f of hlFills) {
    if (f.time < sinceMs || !isPerpCoin(f.coin) || !(f.sz > 0)) continue;
    if (f.oid == null || !Number.isFinite(f.oid)) continue;
    const key = String(f.oid);
    if (knownSzByOid.has(key)) {
      const agg = seenKnown.get(key) ?? { coin: f.coin, sz: 0 };
      agg.sz += f.sz;
      seenKnown.set(key, agg);
      continue;
    }
    const arr = byOid.get(key) ?? [];
    arr.push(f);
    byOid.set(key, arr);
  }
  for (const [hlOrderId, agg] of seenKnown) {
    const booked = knownSzByOid.get(hlOrderId) ?? 0;
    // Tolerance: float-noise on Σsz must not page the operator.
    if (agg.sz - booked > 1e-9) underBooked.push({ hlOrderId, coin: agg.coin, deltaSz: agg.sz - booked });
  }

  const out: BackfillCandidate[] = [];
  for (const [hlOrderId, rows] of byOid) {
    const sz = rows.reduce((s, r) => s + r.sz, 0);
    if (!(sz > 0)) continue;
    const notionalUsd = rows.reduce((s, r) => s + r.px * r.sz, 0);
    out.push({
      coin: rows[0].coin,
      side: rows[0].side,
      px: notionalUsd / sz,
      sz,
      notionalUsd,
      feeUsd: rows.reduce((s, r) => s + (r.fee ?? 0), 0),
      reduceOnly: rows.every((r) => r.dir?.startsWith('Close') ?? false),
      filledAt: Math.max(...rows.map((r) => r.time)),
      hlOrderId,
      rawRows: rows.map((r) => ({ coin: r.coin, side: r.side, px: r.px, sz: r.sz, time: r.time, dir: r.dir, closedPnl: r.closedPnl, fee: r.fee, oid: r.oid ?? null })),
    });
  }
  // Oldest first, so the downstream position fold replays in execution order.
  out.sort((a, b) => a.filledAt - b.filledAt);
  return { candidates: out, underBooked };
}

/**
 * Pick the session a backfilled fill belongs to. Deterministic precedence:
 *   1. the live session currently HOLDING an open position in the coin
 *      (an exchange-side exit belongs to the position it closed);
 *   2. the live session that most recently traded the coin (the position may
 *      already have been flattened by the reconciler);
 *   3. the newest ACTIVE live session (a brand-new coin — e.g. a manual trade
 *      placed directly on the HL app);
 *   4. null — no live session exists at all; the caller must skip, never
 *      invent a session.
 */
export function attributeSession(
  coin: string,
  holderByCoin: Readonly<Record<string, string>>,
  lastTraderByCoin: Readonly<Record<string, string>>,
  newestActiveSessionId: string | null,
): string | null {
  // Normalize like the ledger keys do (buildFillRow uppercases) — HL reports
  // k-prefixed coins as e.g. "kPEPE", which would otherwise miss both maps.
  const key = coin.trim().toUpperCase();
  return holderByCoin[key] ?? lastTraderByCoin[key] ?? newestActiveSessionId ?? null;
}
