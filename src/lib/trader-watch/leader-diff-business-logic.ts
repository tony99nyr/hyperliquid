/**
 * Trade-watch service — PURE leader-diff logic (fully fixture-testable).
 *
 * The trade-watch service (scripts/trader-watch.ts) is an always-on, NON-AGENT
 * poller running on the NAS. Each cycle it fetches the top rated leaders'
 * Hyperliquid `clearinghouseState` and DIFFS this cycle's positions against the
 * previous cycle's to detect ACTIONS (open / add / reduce / close / flip), then
 * writes the current positions + new actions to Supabase for the cockpit.
 *
 * This module holds the deterministic diff + row-shaping logic with NO I/O: given
 * a previous and a current set of position snapshots it returns the actions; given
 * a snapshot/action it returns the snake_case DB row. The I/O wrapper
 * (leader-watch-service.ts + scripts/trader-watch.ts) fetches the snapshots, holds
 * the per-leader previous-snapshot baseline, and persists what these functions
 * return.
 *
 * WATCH-ONLY — like the cockpit watch daemon, NOTHING under `src/lib/trader-watch/`
 * (nor scripts/trader-watch.ts) may import the fill/execution path. It observes
 * and reports; it never trades. `tests/lib/trader-watch/no-trade-guarantee.test.ts`
 * pins this down statically.
 */

export type LeaderSide = 'long' | 'short';
export type LeaderActionKind = 'open' | 'add' | 'reduce' | 'close' | 'flip';

/** One leader's position in one coin — the slim, serializable diff input. */
export interface LeaderPositionSnapshot {
  coin: string;
  side: LeaderSide;
  /** Signed size in coin units (negative = short). */
  szi: number;
  /** Absolute size in coin units. */
  size: number;
  entryPx: number | null;
  positionValue: number;
  unrealizedPnl: number;
  returnOnEquity: number | null;
  leverage: number | null;
  leverageType: string | null;
  liquidationPx: number | null;
}

/** A detected transition between two cycles for one (leader, coin). */
export interface LeaderAction {
  leaderAddress: string;
  coin: string;
  kind: LeaderActionKind;
  prevSide: LeaderSide | null;
  newSide: LeaderSide | null;
  /** Absolute sizes before/after the transition. */
  prevSize: number;
  newSize: number;
  /** newSize − prevSize (positive = grew, negative = shrank). */
  sizeDelta: number;
  /** Current entry / notional / uPnL at detection (0 / null on a close). */
  entryPx: number | null;
  notionalUsd: number;
  unrealizedPnl: number;
}

/**
 * Relative size-change floor before an add/reduce counts — a MATERIALITY gate, not
 * just a float guard. A leader who adds/trims by ≥ this fraction of the prior size
 * registers; smaller moves are treated as noise and emit no action.
 *
 * WHY 5% (was 1e-4): the watched leaders are large market-maker books that
 * continuously rebalance multi-million-dollar positions by hundredths of a percent
 * every poll cycle. At a 0.01% floor, every micro-nudge minted an add/reduce —
 * ~700 actions/hour, ~400k rows/week of pure noise that drowned the few real
 * open/close/flip signals AND defeated the leader_positions "only-on-change"
 * reconcile gate (it keyed on actions.length > 0). 5% is a defensible "the leader
 * MEANINGFULLY changed this position" threshold; open/close/flip are unaffected
 * (they never pass through this floor). Tune here if the feed feels too sparse.
 */
export const MIN_REL_SIZE_DELTA = 0.05;

/** True when |a − b| exceeds the relative floor scaled to the larger magnitude. */
function sizeChanged(prevSize: number, currSize: number): boolean {
  const scale = Math.max(Math.abs(prevSize), Math.abs(currSize), 1e-9);
  return Math.abs(currSize - prevSize) / scale > MIN_REL_SIZE_DELTA;
}

/** Index snapshots by normalized coin for the union walk. */
function byCoin(snapshots: LeaderPositionSnapshot[]): Map<string, LeaderPositionSnapshot> {
  const map = new Map<string, LeaderPositionSnapshot>();
  for (const s of snapshots) map.set(s.coin.trim().toUpperCase(), s);
  return map;
}

/**
 * Diff a leader's previous vs. current positions into actions. PURE + deterministic.
 *
 * Per coin in the union of both sides:
 *   - prev absent, curr present              → `open`
 *   - prev present, curr absent              → `close`
 *   - both present, same side, size grew     → `add`
 *   - both present, same side, size shrank   → `reduce`
 *   - both present, opposite side            → `flip`
 *   - both present, same side, size unchanged → (no action; positions still upsert)
 *
 * Output is ordered by coin (sorted) for stable, testable results. `notionalUsd`
 * / `entryPx` / `unrealizedPnl` carry the CURRENT values, except `close` where the
 * position is gone (notional 0, entry/uPnL from the vanished position for context).
 */
export function diffLeaderPositions(
  leaderAddress: string,
  prev: LeaderPositionSnapshot[],
  curr: LeaderPositionSnapshot[],
): LeaderAction[] {
  const prevMap = byCoin(prev);
  const currMap = byCoin(curr);
  const coins = [...new Set([...prevMap.keys(), ...currMap.keys()])].sort();

  const actions: LeaderAction[] = [];
  for (const coin of coins) {
    const p = prevMap.get(coin);
    const c = currMap.get(coin);

    if (!p && c) {
      actions.push(makeAction(leaderAddress, coin, 'open', null, c, 0, c.size));
      continue;
    }
    if (p && !c) {
      // Closed — report the vanished position's context. Carry the LAST-KNOWN
      // unrealizedPnl (≈ the position's realized P&L at close) instead of zeroing
      // it: this is what makes per-trader realized P&L / win-rate computable from
      // the close stream (previously discarded — the trader-info value gap).
      actions.push({
        leaderAddress,
        coin,
        kind: 'close',
        prevSide: p.side,
        newSide: null,
        prevSize: p.size,
        newSize: 0,
        sizeDelta: -p.size,
        entryPx: p.entryPx,
        notionalUsd: 0,
        unrealizedPnl: p.unrealizedPnl,
      });
      continue;
    }
    if (p && c) {
      if (p.side !== c.side) {
        actions.push(makeAction(leaderAddress, coin, 'flip', p, c, p.size, c.size));
        continue;
      }
      if (!sizeChanged(p.size, c.size)) continue; // same side, no meaningful change
      const kind: LeaderActionKind = c.size > p.size ? 'add' : 'reduce';
      actions.push(makeAction(leaderAddress, coin, kind, p, c, p.size, c.size));
    }
  }
  return actions;
}

/** Build an action whose post-state is `c` (current). PURE. */
function makeAction(
  leaderAddress: string,
  coin: string,
  kind: LeaderActionKind,
  prev: LeaderPositionSnapshot | null,
  c: LeaderPositionSnapshot,
  prevSize: number,
  newSize: number,
): LeaderAction {
  return {
    leaderAddress,
    coin,
    kind,
    prevSide: prev?.side ?? null,
    newSide: c.side,
    prevSize,
    newSize,
    sizeDelta: newSize - prevSize,
    entryPx: c.entryPx,
    notionalUsd: c.positionValue,
    unrealizedPnl: c.unrealizedPnl,
  };
}

// ---------------------------------------------------------------------------
// Row builders (camelCase domain → snake_case DB rows). `id`/`updated_at` are
// filled by the DB defaults on insert; we set them explicitly only where the
// service needs deterministic upsert values.
// ---------------------------------------------------------------------------

export interface LeaderPositionUpsertRow {
  leader_address: string;
  coin: string;
  side: LeaderSide;
  szi: number;
  size: number;
  entry_px: number | null;
  position_value: number;
  unrealized_pnl: number;
  return_on_equity: number | null;
  leverage: number | null;
  leverage_type: string | null;
  liquidation_px: number | null;
  account_value_usd: number | null;
  fetched_at: string;
  updated_at: string;
}

/** Build a leader_positions upsert row for one (leader, coin). PURE. */
export function buildLeaderPositionRow(
  leaderAddress: string,
  snap: LeaderPositionSnapshot,
  accountValueUsd: number | null,
  fetchedAtIso: string,
): LeaderPositionUpsertRow {
  return {
    leader_address: leaderAddress,
    coin: snap.coin.trim().toUpperCase(),
    side: snap.side,
    szi: snap.szi,
    size: snap.size,
    entry_px: snap.entryPx,
    position_value: snap.positionValue,
    unrealized_pnl: snap.unrealizedPnl,
    return_on_equity: snap.returnOnEquity,
    leverage: snap.leverage,
    leverage_type: snap.leverageType,
    liquidation_px: snap.liquidationPx,
    account_value_usd: accountValueUsd,
    fetched_at: fetchedAtIso,
    updated_at: fetchedAtIso,
  };
}

export interface LeaderActionInsertRow {
  leader_address: string;
  coin: string;
  kind: LeaderActionKind;
  prev_side: LeaderSide | null;
  new_side: LeaderSide | null;
  prev_size: number;
  new_size: number;
  size_delta: number;
  entry_px: number | null;
  notional_usd: number;
  unrealized_pnl: number;
}

/** Build a leader_actions insert row from a detected action. PURE. */
export function buildLeaderActionRow(action: LeaderAction): LeaderActionInsertRow {
  return {
    leader_address: action.leaderAddress,
    coin: action.coin.trim().toUpperCase(),
    kind: action.kind,
    prev_side: action.prevSide,
    new_side: action.newSide,
    prev_size: action.prevSize,
    new_size: action.newSize,
    size_delta: action.sizeDelta,
    entry_px: action.entryPx,
    notional_usd: action.notionalUsd,
    unrealized_pnl: action.unrealizedPnl,
  };
}

/**
 * One-line human summary of an action for logs / the analysis feed. PURE.
 * e.g. "0xecb6…1234 opened SHORT ETH (1.128 @ $1772.40, $2000 notional)".
 */
export function formatLeaderAction(action: LeaderAction, shortAddr?: string): string {
  const who = shortAddr ?? action.leaderAddress;
  const verb: Record<LeaderActionKind, string> = {
    open: 'opened',
    add: 'added to',
    reduce: 'reduced',
    close: 'closed',
    flip: 'flipped',
  };
  const side = action.newSide ?? action.prevSide ?? '';
  const px = action.entryPx != null ? ` @ $${action.entryPx}` : '';
  if (action.kind === 'close') {
    return `${who} closed ${action.prevSide ?? ''} ${action.coin} (was ${action.prevSize})`.trim();
  }
  const sizePart =
    action.kind === 'add' || action.kind === 'reduce'
      ? `${action.prevSize} → ${action.newSize}`
      : `${action.newSize}`;
  return `${who} ${verb[action.kind]} ${side} ${action.coin} (${sizePart}${px})`.trim();
}
