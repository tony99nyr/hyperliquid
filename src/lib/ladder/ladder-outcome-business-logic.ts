/** Per-coin position inventory for exchange-fill outcome attribution. No I/O. */
import type { HlFill } from '@/lib/hyperliquid/hyperliquid-info-service';
import type { LadderWithRungs } from './ladder-types';

/**
 * Entry match window around ladder_fires.fired_at. Measured on 27 live open/add fires
 * (Jun to Oct 2026): the HL fill landed +1.6s to +2.8s after fired_at, every fire's
 * fills shared ONE oid, and no other same-coin, same-side order filled within ±60s.
 * The window keeps a 3x margin over the slowest fill; -1s absorbs clock skew.
 */
export const ENTRY_MATCH_WINDOW_MS = 10_000;
const EARLY_JITTER_MS = 1_000;
const SIZE_EPSILON = 1e-9;
/** HL rounds sizes to szDecimals (at most 5 dp on the coins we trade). */
const POSITION_EPSILON = 1e-6;

export interface OutcomeFire {
  ladderId: string;
  rungId: string;
  status: string;
  detail: string | null;
  firedAt: number;
}

export interface OwnerLedger {
  owner: string;
  coin: string;
  entrySize: number;
  openSize: number;
  closedPnl: number;
  fees: number;
  lastCloseMs: number | null;
}

export interface CoinConservation {
  coin: string;
  accountClosedPnl: number;
  attributedClosedPnl: number;
  accountFees: number;
  attributedFees: number;
  passed: boolean;
}

/** End-of-history inventory per coin: the lots must equal the replayed and the account position. */
export interface InventoryCheck {
  coin: string;
  replayedPosition: number;
  lotPosition: number;
  /** Signed live position from clearinghouseState, or null when the caller has none. */
  accountPosition: number | null;
  passed: boolean;
}

/** A fill whose HL `startPosition` differs from the replayed position: fills are missing. */
export interface ContinuityBreak { coin: string; time: number; startPosition: number; replayedPosition: number }

export interface FillAttribution {
  byLadder: Map<string, OwnerLedger>;
  manual: Map<string, OwnerLedger>;
  conservation: CoinConservation[];
  inventory: InventoryCheck[];
  continuityBreaks: ContinuityBreak[];
  /** Ladders that hold open lots on a coin where the account is flat or on the other side. */
  openLadderViolations: string[];
  fallbackCount: number;
  unmatchedEntryCount: number;
}

export interface AttributionOptions {
  /** Signed account position per coin (upper-case) at fetch time. Missing coin ≡ flat. */
  finalPositions?: ReadonlyMap<string, number>;
}

const signed = (side: 'buy' | 'sell', size: number): number => (side === 'buy' ? size : -size);

/**
 * Time order. HL stamps every fill of one sweep with the same ms and lists them in either
 * order, so same-ms fills on one coin and side follow their `startPosition` chain.
 */
function chronological(a: { fill: HlFill; index: number }, b: { fill: HlFill; index: number }): number {
  const x = a.fill;
  const y = b.fill;
  if (x.time !== y.time) return x.time - y.time;
  const coin = x.coin.toUpperCase().localeCompare(y.coin.toUpperCase());
  if (coin !== 0) return coin;
  if (x.side === y.side && x.startPosition != null && y.startPosition != null && x.startPosition !== y.startPosition) {
    return x.side === 'buy' ? x.startPosition - y.startPosition : y.startPosition - x.startPosition;
  }
  return a.index - b.index;
}

interface Lot { owner: string; size: number; side: 'buy' | 'sell' }
interface EntryFire extends OutcomeFire { coin: string; side: 'buy' | 'sell'; entryOid: number | null }

function entryOid(detail: string | null): number | null {
  if (!detail) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (typeof parsed !== 'object' || parsed === null || !('entryOid' in parsed)) return null;
    const raw = parsed.entryOid;
    const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

function ledger(owner: string, coin: string): OwnerLedger {
  return { owner, coin, entrySize: 0, openSize: 0, closedPnl: 0, fees: 0, lastCloseMs: null };
}

/** A closing fill follows the owner of the inventory it reduces, regardless of its oid. */
export function attributeLadderFills(ladders: LadderWithRungs[], fires: OutcomeFire[], fills: HlFill[],
  options: AttributionOptions = {}): FillAttribution {
  const byLadder = new Map(ladders.map((item) => [item.id, ledger(item.id, item.rungs[0]?.coin.toUpperCase() ?? '')]));
  const ladderCoinRows = new Map<string, OwnerLedger>();
  const manual = new Map<string, OwnerLedger>();
  const rungById = new Map(ladders.flatMap((item) => item.rungs.map((rung) => [rung.id, rung] as const)));
  const entries: EntryFire[] = fires.flatMap((fire) => {
    const rung = rungById.get(fire.rungId);
    if (fire.status !== 'filled' || !rung || rung.ladderId !== fire.ladderId ||
      (rung.action !== 'open' && rung.action !== 'add')) return [];
    return [{ ...fire, coin: rung.coin.toUpperCase(), side: rung.side === 'long' ? 'buy' as const : 'sell' as const,
      entryOid: entryOid(fire.detail) }];
  });
  const claimedFires = new Set<string>();
  const historicalOids = new Map<string, string>();
  const lotsByCoin = new Map<string, Lot[]>();
  const replayed = new Map<string, number>();
  const continuityBreaks: ContinuityBreak[] = [];
  let fallbackCount = 0;
  let unmatchedEntryCount = 0;
  const ownerLedger = (owner: string, coin: string): OwnerLedger => {
    if (owner !== 'manual') {
      if (!byLadder.has(owner)) throw new Error(`Unknown ladder owner ${owner}`);
      const key = `${owner}:${coin}`;
      const row = ladderCoinRows.get(key) ?? ledger(owner, coin);
      ladderCoinRows.set(key, row);
      return row;
    }
    const row = manual.get(coin) ?? ledger('manual', coin);
    manual.set(coin, row);
    return row;
  };
  const matchEntry = (fill: HlFill, coin: string): string => {
    const oid = fill.oid == null ? null : Number(fill.oid);
    const identity = entries.filter((fire) => fire.coin === coin && fire.side === fill.side &&
      oid != null && fire.entryOid === oid);
    if (identity.length > 1 && new Set(identity.map((fire) => fire.ladderId)).size > 1) {
      throw new Error(`Conflicting entry oid ${oid} for ${coin}`);
    }
    if (identity.length) return identity[0].ladderId;
    const prior = oid == null ? null : historicalOids.get(`${coin}:${oid}`);
    if (prior) return prior;
    const candidates = entries.filter((fire) => fire.entryOid === null && !claimedFires.has(`${fire.ladderId}:${fire.rungId}`)
      && fire.coin === coin && fire.side === fill.side
      && fill.time >= fire.firedAt - EARLY_JITTER_MS
      && fill.time <= fire.firedAt + ENTRY_MATCH_WINDOW_MS)
      .sort((a, b) => Math.abs(fill.time - a.firedAt) - Math.abs(fill.time - b.firedAt)
        || a.firedAt - b.firedAt || a.rungId.localeCompare(b.rungId));
    const best = candidates[0];
    if (!best) { unmatchedEntryCount++; return 'manual'; }
    claimedFires.add(`${best.ladderId}:${best.rungId}`);
    if (oid != null) historicalOids.set(`${coin}:${oid}`, best.ladderId);
    fallbackCount++;
    return best.ladderId;
  };

  for (const { index, fill } of fills.map((fill, index) => ({ fill, index })).sort(chronological)) {
    if (!Number.isFinite(fill.sz) || fill.sz <= 0 || !Number.isFinite(fill.time)
      || !Number.isFinite(fill.closedPnl ?? 0) || !Number.isFinite(fill.fee ?? 0)) {
      throw new Error(`Invalid fill at index ${index}`);
    }
    const coin = fill.coin.toUpperCase();
    const before = replayed.get(coin) ?? 0;
    if (fill.startPosition != null && Math.abs(fill.startPosition - before) > POSITION_EPSILON) {
      continuityBreaks.push({ coin, time: fill.time, startPosition: fill.startPosition, replayedPosition: before });
    }
    replayed.set(coin, before + signed(fill.side, fill.sz));
    const lots = lotsByCoin.get(coin) ?? [];
    lotsByCoin.set(coin, lots);
    let remaining = fill.sz;
    const gross = fill.closedPnl ?? 0;
    const fee = fill.fee ?? 0;
    const closingSize = lots.length && lots[0].side !== fill.side
      ? Math.min(fill.sz, lots.reduce((sum, lot) => sum + lot.size, 0)) : 0;
    while (remaining > SIZE_EPSILON && lots.length && lots[0].side !== fill.side) {
      const lot = lots[0];
      const taken = Math.min(remaining, lot.size);
      const row = ownerLedger(lot.owner, coin);
      row.closedPnl += gross * taken / closingSize;
      row.fees += fee * taken / fill.sz;
      row.openSize -= taken;
      row.lastCloseMs = fill.time;
      lot.size -= taken;
      remaining -= taken;
      if (lot.size <= SIZE_EPSILON) lots.shift();
    }
    if (remaining > SIZE_EPSILON) {
      const owner = matchEntry(fill, coin);
      const row = ownerLedger(owner, coin);
      row.entrySize += remaining;
      row.openSize += remaining;
      if (closingSize === 0) row.closedPnl += gross;
      row.fees += fee * remaining / fill.sz;
      lots.push({ owner, side: fill.side, size: remaining });
    }
  }

  for (const row of ladderCoinRows.values()) {
    const total = byLadder.get(row.owner);
    if (!total) throw new Error(`Unknown ladder owner ${row.owner}`);
    total.entrySize += row.entrySize;
    total.openSize += row.openSize;
    total.closedPnl += row.closedPnl;
    total.fees += row.fees;
    total.lastCloseMs = Math.max(total.lastCloseMs ?? 0, row.lastCloseMs ?? 0) || null;
  }
  const conservation = [...new Set(fills.map((fill) => fill.coin.toUpperCase()))].sort().map((coin) => {
    const source = fills.filter((fill) => fill.coin.toUpperCase() === coin);
    const owners = [...ladderCoinRows.values(), ...manual.values()].filter((row) => row.coin === coin);
    const accountClosedPnl = source.reduce((sum, fill) => sum + (fill.closedPnl ?? 0), 0);
    const accountFees = source.reduce((sum, fill) => sum + (fill.fee ?? 0), 0);
    const attributedClosedPnl = owners.reduce((sum, row) => sum + row.closedPnl, 0);
    const attributedFees = owners.reduce((sum, row) => sum + row.fees, 0);
    const passed = Math.abs(accountClosedPnl - attributedClosedPnl) <= 0.01
      && Math.abs(accountFees - attributedFees) <= 0.01;
    return { coin, accountClosedPnl, attributedClosedPnl, accountFees, attributedFees, passed };
  });
  if (conservation.some((item) => !item.passed)) throw new Error('Fill attribution conservation failed');
  const coins = [...new Set([...lotsByCoin.keys(), ...(options.finalPositions?.keys() ?? [])])].sort();
  const inventory = coins.map((coin): InventoryCheck => {
    const replayedPosition = replayed.get(coin) ?? 0;
    const lotPosition = (lotsByCoin.get(coin) ?? []).reduce((sum, lot) => sum + signed(lot.side, lot.size), 0);
    const accountPosition = options.finalPositions ? options.finalPositions.get(coin) ?? 0 : null;
    const passed = Math.abs(lotPosition - replayedPosition) <= POSITION_EPSILON
      && (accountPosition == null || Math.abs(lotPosition - accountPosition) <= POSITION_EPSILON);
    return { coin, replayedPosition, lotPosition, accountPosition, passed };
  });
  const openLadderViolations = [...ladderCoinRows.values()].flatMap((row) => {
    if (row.openSize <= POSITION_EPSILON) return [];
    const check = inventory.find((item) => item.coin === row.coin);
    const reference = check?.accountPosition ?? check?.lotPosition ?? 0;
    const side = (lotsByCoin.get(row.coin) ?? []).find((lot) => lot.owner === row.owner)?.side;
    const sameSign = side != null && Math.abs(reference) > POSITION_EPSILON && Math.sign(reference) === Math.sign(signed(side, 1));
    return sameSign ? [] : [`${row.owner} holds ${row.openSize} ${row.coin} but the account position is ${reference}`];
  });
  return { byLadder, manual, conservation, inventory, continuityBreaks, openLadderViolations,
    fallbackCount, unmatchedEntryCount };
}

/** Every reason the attribution must not be written. Empty ≡ safe to persist. */
export function attributionInvariantFailures(result: FillAttribution): string[] {
  return [
    ...result.conservation.filter((item) => !item.passed).map((item) => `${item.coin}: P&L or fee conservation failed`),
    ...result.continuityBreaks.map((item) => `${item.coin}: fill at ${item.time} starts at ${item.startPosition}, replay has ${item.replayedPosition} (missing fills)`),
    ...result.inventory.filter((item) => !item.passed).map((item) => `${item.coin}: lots ${item.lotPosition} vs replay ${item.replayedPosition} vs account ${item.accountPosition ?? 'unknown'}`),
    ...result.openLadderViolations,
  ];
}
