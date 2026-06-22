/**
 * PURE leader de-risk signal — "is smart money fleeing this coin?". From the
 * recent leader-action stream, per coin: USD-weighted size LEAVING (reduce / close
 * / flip-out) vs size ENTERING (open / add). ∈ [0,1]; >0.5 = net de-risking.
 *
 * This is the one trader-data angle NOT killed by the copy-trading studies: used
 * as a low-frequency RISK-OFF veto (not a copy), it sidesteps the friction wall
 * (it gates entries, it doesn't trade). Computed + stored now so it accumulates
 * for backtesting; the rubric veto that consumes it ships config-gated OFF until
 * a backtest validates it. No I/O. Fixture-tested.
 */

export type LeaderActionKind = 'open' | 'add' | 'reduce' | 'close' | 'flip';

export interface DeriskAction {
  coin: string;
  kind: LeaderActionKind;
  /** newSize − prevSize (sign: + grew, − shrank). */
  sizeDelta: number;
  /** Price context for USD weighting (entry px at detection); falls back to 1. */
  entryPx: number | null;
}

const px = (a: DeriskAction): number => (a.entryPx && a.entryPx > 0 ? a.entryPx : 1);

/**
 * Per-coin de-risk intensity ∈ [0,1] over the supplied (already time-windowed)
 * actions. null for a coin with no qualifying activity. open/add = risk-ON
 * (entering); reduce/close/flip = risk-OFF (leaving), weighted by |sizeDelta|·px.
 */
export function computeLeaderDerisk(actions: DeriskAction[]): Record<string, number> {
  const on: Record<string, number> = {};
  const off: Record<string, number> = {};
  for (const a of actions) {
    const coin = a.coin.toUpperCase();
    const usd = Math.abs(a.sizeDelta) * px(a);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    if (a.kind === 'open' || a.kind === 'add') on[coin] = (on[coin] ?? 0) + usd;
    else off[coin] = (off[coin] ?? 0) + usd; // reduce / close / flip
  }
  const out: Record<string, number> = {};
  const coins = new Set([...Object.keys(on), ...Object.keys(off)]);
  for (const coin of coins) {
    const o = off[coin] ?? 0;
    const i = on[coin] ?? 0;
    const total = o + i;
    if (total <= 0) continue;
    out[coin] = o / total; // 0 = all risk-on, 1 = all de-risking
  }
  return out;
}

/** True when de-risking is intense enough to veto a LONG (the risk-off read). */
export function isMassDerisking(derisk: number | null | undefined, threshold: number): boolean {
  return derisk != null && Number.isFinite(derisk) && derisk >= threshold;
}
