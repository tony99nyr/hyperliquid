/**
 * Protective-stop I/O seam — place / cancel / find a reduce-only STOP-LOSS trigger
 * order on HL (rests on the exchange; fires even if our infra is offline). Mode-
 * branched: LIVE signs + submits; PAPER is a no-op (the cockpit's paper book has no
 * resting HL orders). Live-signing I/O is isolated in hyperliquid-exchange-service.
 *
 * A "stop" = a reduce-only trigger order with a Stop order type. reduce-only → it can
 * only CLOSE, never increase exposure. The op never touches a key here.
 */

import 'server-only';
import { getTradingMode } from '@/lib/env/mode';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { validateEnv } from '@/lib/env/env';
import { fetchOpenOrders, type HlOpenOrder } from '@/lib/hyperliquid/hyperliquid-info-service';
import { submitStopOrder, submitBracket, submitCancel } from '@/lib/hyperliquid/hyperliquid-exchange-service';

/** A reduce-only Stop trigger order (vs a take-profit or a plain limit). */
function isStopOrder(o: HlOpenOrder): boolean {
  return o.isTrigger && o.reduceOnly && /stop/i.test(o.orderType);
}

/** The resting protective stop for `coin`, or null. Reads the live account orders. */
export async function findOpenStop(coin: string): Promise<HlOpenOrder | null> {
  const address = getHlAccountAddress();
  if (!address) return null;
  const orders = await fetchOpenOrders(address, validateEnv().HL_NETWORK);
  const c = coin.trim().toUpperCase();
  return orders.find((o) => o.coin === c && isStopOrder(o)) ?? null;
}

/** A resting protective stop, trimmed to what the UI needs. */
export interface RestingStop {
  oid: number;
  triggerPx: number | null;
  sz: number;
}

/**
 * ALL resting reduce-only protective stops, keyed by coin — in ONE HL call (so the
 * positions panel can flag every coin's protection without N per-row fetches). Empty
 * when no account address (paper has no resting exchange stops). One-per-coin is
 * enforced on place, so a coin maps to at most one stop (first wins defensively).
 */
export async function findAllStops(): Promise<Record<string, RestingStop>> {
  const address = getHlAccountAddress();
  if (!address) return {};
  const orders = await fetchOpenOrders(address, validateEnv().HL_NETWORK);
  const out: Record<string, RestingStop> = {};
  for (const o of orders) {
    if (!isStopOrder(o) || out[o.coin]) continue;
    out[o.coin] = { oid: o.oid, triggerPx: o.triggerPx, sz: o.sz };
  }
  return out;
}

/**
 * Place a reduce-only stop-market for `coin` at `triggerPx`, `size`, sized to the
 * position. `side` is the POSITION side; the stop order is the opposite (a long's
 * stop SELLS). LIVE only; PAPER no-op. Throws on HL rejection (fail-closed).
 */
export async function placeStopOnHl(coin: string, triggerPx: number, size: number, side: 'long' | 'short'): Promise<{ pushed: boolean; oid: number | null }> {
  if (getTradingMode() !== 'live') return { pushed: false, oid: null };
  const { oid } = await submitStopOrder(coin, triggerPx, size, side === 'short'); // short stop BUYS, long stop SELLS
  return { pushed: true, oid };
}

/** Cancel a resting order by (coin, oid). LIVE only; PAPER no-op. */
export async function cancelStopOnHl(coin: string, oid: number): Promise<{ pushed: boolean }> {
  if (getTradingMode() !== 'live') return { pushed: false };
  await submitCancel(coin, oid);
  return { pushed: true };
}

// ─── Take-profit: the profit-side sibling of the protective stop ───────────────
// Same reduce-only trigger mechanism, fires on a FAVOURABLE move ('tp'). Distinct
// HL orderType ("Take Profit Market") so it never collides with the stop matcher.

/** A reduce-only Take-Profit trigger order. */
function isTpOrder(o: HlOpenOrder): boolean {
  return o.isTrigger && o.reduceOnly && /take[\s-]?profit/i.test(o.orderType);
}

/** The resting take-profit for `coin`, or null. Reads the live account orders. */
export async function findOpenTp(coin: string): Promise<HlOpenOrder | null> {
  const address = getHlAccountAddress();
  if (!address) return null;
  const orders = await fetchOpenOrders(address, validateEnv().HL_NETWORK);
  const c = coin.trim().toUpperCase();
  return orders.find((o) => o.coin === c && isTpOrder(o)) ?? null;
}

/**
 * Place a reduce-only TAKE-PROFIT for `coin` — same order side as a stop (opposite
 * the position: a long's TP SELLS) but fires on the PROFIT side. LIVE only; PAPER
 * no-op. Throws on HL rejection (fail-closed).
 */
export async function placeTpOnHl(coin: string, triggerPx: number, size: number, side: 'long' | 'short'): Promise<{ pushed: boolean; oid: number | null }> {
  if (getTradingMode() !== 'live') return { pushed: false, oid: null };
  const { oid } = await submitStopOrder(coin, triggerPx, size, side === 'short', 'tp');
  return { pushed: true, oid };
}

/** Cancel a resting take-profit by (coin, oid) — same mechanism as a stop cancel. */
export const cancelTpOnHl = cancelStopOnHl;

/**
 * Place a native OCO BRACKET (stop + take-profit, mutually-cancelling) on the position
 * in ONE action. `side` is the POSITION side; both legs are the opposite (they close).
 * LIVE only; PAPER no-op. Throws if either leg is rejected (fail-closed). The two
 * orders auto-cancel each other on fill and both auto-cancel when the position closes —
 * no orphan reduce-only order on a flat position.
 */
export async function placeBracketOnHl(coin: string, stopPx: number, tpPx: number, size: number, side: 'long' | 'short'): Promise<{ pushed: boolean; stopOid: number | null; tpOid: number | null }> {
  if (getTradingMode() !== 'live') return { pushed: false, stopOid: null, tpOid: null };
  const { stopOid, tpOid } = await submitBracket(coin, stopPx, tpPx, size, side === 'short'); // long bracket SELLS, short BUYS
  return { pushed: true, stopOid, tpOid };
}
