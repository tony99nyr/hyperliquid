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
import { submitStopOrder, submitCancel } from '@/lib/hyperliquid/hyperliquid-exchange-service';

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
