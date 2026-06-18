/**
 * PURE order logic for the HL exchange service — the auditable layer we own
 * (the cryptographic msgpack+EIP-712 signing is delegated to @nktkas/hyperliquid;
 * everything HERE — formatting, action construction, response parsing — is plain,
 * inspectable, and unit-tested). No I/O, no keys, no React.
 *
 * Refs: HL tick/lot-size + exchange-endpoint docs, cross-checked against the
 * hyperliquid-python-sdk + @nktkas/hyperliquid (see the Phase-3 signing spec).
 */

export type HlTif = 'Ioc' | 'Gtc' | 'Alo';

/** The exact `order` action HL hashes. KEY ORDER IS LOAD-BEARING (insertion order
 *  = msgpack serialization order = the signed bytes): type, orders, grouping; and
 *  within an order a, b, p, s, r, t. p and s MUST be strings. */
export interface HlOrderAction {
  type: 'order';
  orders: Array<{
    a: number; // asset index
    b: boolean; // isBuy
    p: string; // price (formatted)
    s: string; // size (formatted, base units)
    r: boolean; // reduceOnly
    t: { limit: { tif: HlTif } };
  }>;
  grouping: 'na';
}

/** Normalized parse of an HL /exchange order response (see parseOrderResponse). */
export interface ParsedOrderResult {
  filled: boolean;
  oid: number | null;
  filledSize: number;
  avgPrice: number | null;
}

/** Strip trailing zeros (and a bare trailing dot) from a decimal string. */
export function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * Format an order SIZE to the coin's szDecimals (HL lot-size rule). Rounds DOWN
 * (floor toward zero) so the order can never exceed the requested size — critical
 * for a reduce-only close that must not overshoot the position. A size that floors
 * to 0 (sub-lot) is left as "0"; the caller (submitOrder) pre-flight-rejects it
 * rather than shipping a zero-size order HL would bounce.
 */
export function formatHlSize(sz: number, szDecimals: number): string {
  const d = Math.max(0, szDecimals);
  const f = 10 ** d;
  const floored = Math.floor(sz * f) / f;
  return trimZeros(floored.toFixed(d));
}

/**
 * Format an order PRICE per HL's tick rule: integers always allowed; otherwise
 * <= 5 significant figures AND <= (MAX_DECIMALS - szDecimals) decimals, where
 * MAX_DECIMALS = 6 for perps (8 for spot). Trailing zeros stripped.
 */
export function formatHlPrice(px: number, szDecimals: number, isPerp = true): string {
  if (Number.isInteger(px)) return String(px);
  const maxDec = (isPerp ? 6 : 8) - szDecimals;
  const sigFig = Number(px.toPrecision(5)); // clamp to 5 significant figures
  return trimZeros(sigFig.toFixed(Math.max(0, maxDec)));
}

/**
 * The aggressive limit price that makes an IOC order cross the book (HL has no
 * true market order). Buy → mark × (1 + buffer); sell → mark × (1 − buffer). HL
 * fills at the resting book, never worse than this limit, so the buffer only
 * guarantees the cross; `buffer` bounds the worst-case slippage.
 */
export function aggressiveIocPrice(mark: number, isBuy: boolean, bufferFrac: number): number {
  return isBuy ? mark * (1 + bufferFrac) : mark * (1 - bufferFrac);
}

/** Build the IOC order action. PURE; preserves the load-bearing key order. */
export function buildIocOrderAction(input: {
  assetIndex: number;
  isBuy: boolean;
  priceStr: string;
  sizeStr: string;
  reduceOnly: boolean;
}): HlOrderAction {
  return {
    type: 'order',
    orders: [
      {
        a: input.assetIndex,
        b: input.isBuy,
        p: input.priceStr,
        s: input.sizeStr,
        r: input.reduceOnly,
        t: { limit: { tif: 'Ioc' } },
      },
    ],
    grouping: 'na',
  };
}

/** Resolve a coin symbol to its perp asset index + szDecimals from `meta.universe`. */
export function resolveAsset(
  universe: ReadonlyArray<{ name: string; szDecimals: number }>,
  coin: string,
): { assetIndex: number; szDecimals: number } {
  const norm = coin.trim().toUpperCase();
  const idx = universe.findIndex((u) => u.name.toUpperCase() === norm);
  if (idx < 0) throw new Error(`coin not in HL perp universe: ${coin}`);
  return { assetIndex: idx, szDecimals: universe[idx].szDecimals };
}

type OrderStatus =
  | { filled: { totalSz: string; avgPx: string; oid: number } }
  | { resting: { oid: number } }
  | { error: string };

/**
 * Parse the /exchange order response into a normalized result. THROWS on a
 * top-level failure or a per-order error (so the caller surfaces it to the
 * operator). An IOC that didn't cross comes back `resting` → treated as NO FILL
 * (filledSize 0), NOT an error (the unfilled remainder is simply canceled).
 */
export function parseOrderResponse(json: unknown): ParsedOrderResult {
  const j = json as {
    status?: string;
    response?: unknown;
  };
  if (j?.status !== 'ok') {
    const detail = typeof j?.response === 'string' ? j.response : JSON.stringify(j?.response ?? j);
    throw new Error(`HL exchange rejected: ${detail}`);
  }
  const data = (j.response as { data?: { statuses?: OrderStatus[] } } | undefined)?.data;
  const st = data?.statuses?.[0];
  if (!st) throw new Error('HL exchange: no order status in response');
  if ('error' in st) throw new Error(`HL order error: ${st.error}`);
  if ('filled' in st) {
    return {
      filled: true,
      oid: st.filled.oid,
      filledSize: Number(st.filled.totalSz),
      avgPrice: Number(st.filled.avgPx),
    };
  }
  if ('resting' in st) {
    return { filled: false, oid: st.resting.oid, filledSize: 0, avgPrice: null };
  }
  throw new Error(`HL exchange: unknown order status ${JSON.stringify(st)}`);
}
