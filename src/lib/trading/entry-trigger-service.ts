/**
 * Stop-entry I/O seam — place / cancel / find a resting trigger-to-OPEN on HL (a
 * breakout/breakdown entry that rests on the exchange and fires a market open when the
 * mark crosses the level). Mode-branched: LIVE signs + submits; PAPER is a no-op.
 *
 * An "entry trigger" = a NON-reduce-only trigger order (distinct from the protective
 * stop, which is reduce-only). It OPENS exposure, so the route gates it with the LIVE
 * typed-phrase. The operator never touches a key here.
 */

import 'server-only';
import { getTradingMode } from '@/lib/env/mode';
import { getHlAccountAddress } from '@/lib/auto-exit/auto-exit-config';
import { validateEnv } from '@/lib/env/env';
import { fetchOpenOrders, type HlOpenOrder } from '@/lib/hyperliquid/hyperliquid-info-service';
import { submitEntryTrigger, submitCancel } from '@/lib/hyperliquid/hyperliquid-exchange-service';

/** A NON-reduce-only trigger order = a resting entry (vs a reduce-only stop/TP). */
function isEntryTrigger(o: HlOpenOrder): boolean {
  return o.isTrigger && !o.reduceOnly;
}

export interface RestingEntryTrigger {
  oid: number;
  triggerPx: number | null;
  sz: number;
  /** 'A' = sell (short entry), 'B' = buy (long entry) — HL side convention. */
  side: string;
}

/** The resting entry trigger for `coin`, or null. Reads the live account orders. */
export async function findOpenEntryTrigger(coin: string): Promise<RestingEntryTrigger | null> {
  const address = getHlAccountAddress();
  if (!address) return null;
  const orders = await fetchOpenOrders(address, validateEnv().HL_NETWORK);
  const c = coin.trim().toUpperCase();
  const o = orders.find((x) => x.coin === c && isEntryTrigger(x));
  return o ? { oid: o.oid, triggerPx: o.triggerPx, sz: o.sz, side: o.side } : null;
}

/**
 * Place a resting STOP-ENTRY for `coin` at `triggerPx`, `size`, `leverage`. `side` is
 * the POSITION side to OPEN (long = buy on an up-break above mark; short = sell on a
 * down-break below mark). LIVE only; PAPER no-op. Throws on HL rejection (fail-closed).
 */
export async function placeEntryTriggerOnHl(coin: string, triggerPx: number, size: number, side: 'long' | 'short', leverage: number): Promise<{ pushed: boolean; oid: number | null }> {
  if (getTradingMode() !== 'live') return { pushed: false, oid: null };
  const { oid } = await submitEntryTrigger(coin, triggerPx, size, side === 'long', leverage);
  return { pushed: true, oid };
}

/** Cancel a resting entry trigger by (coin, oid). LIVE only; PAPER no-op. */
export async function cancelEntryTriggerOnHl(coin: string, oid: number): Promise<{ pushed: boolean }> {
  if (getTradingMode() !== 'live') return { pushed: false };
  await submitCancel(coin, oid);
  return { pushed: true };
}
