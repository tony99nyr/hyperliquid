/**
 * OI-cascade detector — PURE. Tier-3 v1 of "watch the liquidation conditions"
 * (operator ask, 08-21, after $3B of liquidations fueled the buyback rally):
 * a liquidation cascade is mechanically **price moving hard while open interest
 * drops hard** — forced closes destroy OI. HL exposes no clean global liquidation
 * feed (userFills carries per-user flags only; recentTrades is 10 unflagged rows),
 * but we already poll OI — so the cascade SIGNATURE is watchable deterministically:
 *   px ↑ ≥ minPxMoveFrac AND OI ↓ ≥ minOiDropFrac  →  SHORT-SQUEEZE (shorts flushed)
 *   px ↓ ≥ minPxMoveFrac AND OI ↓ ≥ minOiDropFrac  →  LONG-FLUSH   (longs liquidated)
 * measured against a rolling anchor (the price-drift pattern: anchors persist across
 * ticks so a multi-tick cascade accumulates; re-anchor on fire or after windowMs).
 *
 * CONTEXT, not a signal: events surface as 'info' triggers + snapshot context. The
 * pre-registered liquidation-fade lane (queued) would be the tradeable descendant,
 * built on a real fill-level feed. Squeeze fuel burning ≠ direction.
 */

export interface OiAnchor {
  oi: number;
  px: number;
  atMs: number;
}

export interface OiCascadeConfig {
  /** Re-anchor after this long without an event (rolling window). */
  windowMs: number;
  /** OI must DROP at least this fraction vs the anchor (0.03 = 3%). */
  minOiDropFrac: number;
  /** |price move| vs the anchor must be at least this fraction (0.015 = 1.5%). */
  minPxMoveFrac: number;
}

export const DEFAULT_OI_CASCADE_CONFIG: OiCascadeConfig = {
  windowMs: 45 * 60_000,
  minOiDropFrac: 0.03,
  minPxMoveFrac: 0.015,
};

export interface OiCascadeEvent {
  coin: string;
  kind: 'short-squeeze' | 'long-flush';
  pxMoveFrac: number; // signed vs anchor
  oiDropFrac: number; // positive = drop
  detail: string;
}

export interface OiCascadeResult {
  events: OiCascadeEvent[];
  nextAnchors: Record<string, OiAnchor>;
}

/**
 * Evaluate one tick. `anchors` is the persisted per-coin baseline (may be empty —
 * first sight of a coin just anchors it). Degenerate inputs (zero/absent OI or px)
 * never fire and re-anchor defensively.
 */
export function detectOiCascades(
  anchors: Record<string, OiAnchor>,
  current: Array<{ coin: string; oi: number; px: number }>,
  now: number,
  cfg: OiCascadeConfig = DEFAULT_OI_CASCADE_CONFIG,
): OiCascadeResult {
  const events: OiCascadeEvent[] = [];
  const nextAnchors: Record<string, OiAnchor> = {};

  for (const cur of current) {
    const coin = cur.coin.toUpperCase();
    if (!(cur.oi > 0) || !(cur.px > 0)) continue; // degenerate → drop (no anchor carry)
    const a = anchors[coin];
    if (!a || !(a.oi > 0) || !(a.px > 0) || now - a.atMs >= cfg.windowMs) {
      nextAnchors[coin] = { oi: cur.oi, px: cur.px, atMs: now }; // (re-)anchor
      continue;
    }
    const pxMoveFrac = cur.px / a.px - 1;
    const oiDropFrac = 1 - cur.oi / a.oi;
    if (oiDropFrac >= cfg.minOiDropFrac && Math.abs(pxMoveFrac) >= cfg.minPxMoveFrac) {
      const kind: OiCascadeEvent['kind'] = pxMoveFrac > 0 ? 'short-squeeze' : 'long-flush';
      events.push({
        coin,
        kind,
        pxMoveFrac,
        oiDropFrac,
        detail:
          `${coin} ${kind.toUpperCase()}: px ${pxMoveFrac > 0 ? '+' : ''}${(pxMoveFrac * 100).toFixed(1)}% with OI ` +
          `−${(oiDropFrac * 100).toFixed(1)}% in ${Math.round((now - a.atMs) / 60_000)}min — forced ` +
          `${kind === 'short-squeeze' ? 'short-covering' : 'long-liquidation'} burning fuel (context: cascades borrow future ` +
          `${kind === 'short-squeeze' ? 'buying' : 'selling'}; expect the move to lose its bid when the fuel is spent)`,
      });
      nextAnchors[coin] = { oi: cur.oi, px: cur.px, atMs: now }; // re-anchor post-event
    } else {
      nextAnchors[coin] = a; // keep accumulating against the standing anchor
    }
  }

  return { events, nextAnchors };
}
