/**
 * Hyperliquid exchange service (Phase 3) — signs + submits orders to the HL
 * `/exchange` endpoint. This is the ISOLATED, security-critical live I/O: the
 * agent-key read + EIP-712 signing live here and NOWHERE else, so the rest of the
 * codebase (and the paper path) never touches a key.
 *
 * KEY MODEL: a dedicated HL AGENT / API wallet — trade-only, CANNOT withdraw,
 * revocable on HL. Its private key is read SERVER-SIDE ONLY from
 * `HL_AGENT_PRIVATE_KEY` (never the main key; never the browser bundle). A leak
 * can place trades but can never move funds out.
 *
 * SPLIT: the cryptographic msgpack+EIP-712 hashing is delegated to the vetted
 * @nktkas/hyperliquid signL1Action (the silent-rejection trap is the encoder —
 * we don't hand-roll it). Everything we own — building the IOC action, the POST,
 * parsing the response — is the PURE hyperliquid-order-business-logic (unit
 * tested), so the auditable surface is ours and the crypto is battle-tested.
 *
 * HL has no true market order: we cross the book with an aggressive IOC limit
 * (mark ± SLIPPAGE_BUFFER); HL fills at the resting book (never worse than the
 * limit), so the buffer only guarantees the cross and bounds worst-case slippage.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { signL1Action } from '@nktkas/hyperliquid/signing';
import type { TradeIntent } from '@/types/fill';
import { fetchPerpMeta, fetchAllMids } from './hyperliquid-info-service';
import { modelFeeUsd } from '@/lib/trading/paper-fee-model';
import {
  resolveAsset,
  formatHlSize,
  formatHlPrice,
  aggressiveIocPrice,
  buildIocOrderAction,
  buildStopOrderAction,
  buildBracketAction,
  buildEntryTriggerAction,
  parseOrderResponse,
} from './hyperliquid-order-business-logic';

/** Worst-case slippage buffer for the market-equivalent IOC limit (5%). HL fills
 *  at the book, so this only ensures the order crosses; it caps the worst price. */
const SLIPPAGE_BUFFER = 0.05;

const EXCHANGE_URL = {
  mainnet: 'https://api.hyperliquid.xyz/exchange',
  testnet: 'https://api.hyperliquid-testnet.xyz/exchange',
} as const;

/** ms-timestamp nonce, kept strictly monotonic per process (HL tracks nonces per
 *  signer; a backwards/duplicate nonce is rejected). */
let lastNonce = 0;
function nextNonce(): number {
  const n = Math.max(Date.now(), lastNonce + 1);
  lastNonce = n;
  return n;
}

export interface HlOrderResult {
  /** Volume-weighted average fill price (0 when nothing filled). */
  avgPx: number;
  /** Filled size in coin units (0 when nothing filled / resting / rejected). */
  filledSz: number;
  /** True when filled size is short of the requested size. */
  partial: boolean;
  /** Fee paid in USD — modeled from HL's taker schedule (the order response does
   *  not carry the fee; userFills would, a later refinement). */
  feeUsd: number;
  /** HL order id (`oid`) as a string, or null when none was assigned. */
  hlOrderId: string | null;
  /** Raw HL confirmation payload, retained for audit. */
  raw: Record<string, unknown>;
}

function isTestnet(): boolean {
  return process.env.HL_NETWORK === 'testnet';
}

function readAgentKey(): `0x${string}` {
  const raw = process.env.HL_AGENT_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new Error('HL_AGENT_PRIVATE_KEY is not set — cannot sign live orders.');
  }
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  // Validate shape up front (clear fail vs a viem crash mid-flight): 32-byte hex.
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('HL_AGENT_PRIVATE_KEY is malformed (expected a 32-byte 0x-hex private key).');
  }
  return key as `0x${string}`;
}

/**
 * Set the per-coin leverage on HL via the `updateLeverage` L1 action (signed +
 * submitted exactly like an order). This makes the cockpit's chosen leverage REAL:
 * HL otherwise opens at the account's EXISTING per-coin leverage (e.g. its 20x max),
 * which is the "cockpit says 5x, HL is 20x" bug — leverage was metadata only.
 *
 * Call this BEFORE an opening order. ISOLATED margin by default (isCross=false) — the
 * cockpit's liquidation/ROE math is isolated-margin and isolated caps loss to the
 * position's own margin. Leverage is coerced to a positive integer (HL requires an
 * int). Throws on a rejected action so the caller can ABORT the open (fail-closed:
 * never silently open at the wrong leverage).
 *
 * NOTE: this is live-signing I/O — rehearse on testnet (HL_NETWORK=testnet) before
 * trusting it with real funds.
 */
export async function submitUpdateLeverage(coin: string, leverage: number, isCross = false): Promise<void> {
  const lev = Math.max(1, Math.round(leverage));
  const testnet = isTestnet();
  const network = testnet ? 'testnet' : 'mainnet';
  const wallet = privateKeyToAccount(readAgentKey());
  const universe = await fetchPerpMeta(network);
  const { assetIndex } = resolveAsset(universe, coin);

  // HL `updateLeverage` action — field order { type, asset, isCross, leverage } is
  // the canonical msgpack shape the signature is verified against.
  const action = { type: 'updateLeverage', asset: assetIndex, isCross, leverage: lev };
  const nonce = nextNonce();
  const signature = await signL1Action({ wallet, action: action as unknown as Record<string, unknown>, nonce, isTestnet: testnet });
  const res = await fetch(testnet ? EXCHANGE_URL.testnet : EXCHANGE_URL.mainnet, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature }),
  });
  const json = (await res.json().catch(() => ({}))) as { status?: string };
  if (!res.ok || json.status !== 'ok') {
    throw new Error(`HL updateLeverage(${coin}=${lev}x${isCross ? ' cross' : ' isolated'}) failed: ${JSON.stringify(json)}`);
  }
}

/**
 * Add (or remove) ISOLATED margin on an open position via HL's `updateIsolatedMargin`
 * L1 action — the correct primitive to push an isolated position's liquidation price
 * AWAY without changing size (NOT a martingale add: it posts collateral, it doesn't
 * increase exposure). `amountUsd > 0` adds margin; the action is signed exactly like
 * an order. `isBuy` is the POSITION'S side (true=long, false=short). `ntli` = USD×1e6
 * (HL's integer scaling). Throws on a rejected action (fail-closed). Field order
 * { type, asset, isBuy, ntli } is the canonical msgpack shape the signature covers.
 */
export async function submitUpdateIsolatedMargin(coin: string, amountUsd: number, isBuy: boolean): Promise<void> {
  if (!(amountUsd > 0) || !Number.isFinite(amountUsd)) {
    throw new Error(`submitUpdateIsolatedMargin: amountUsd must be a positive number (got ${amountUsd})`);
  }
  const ntli = Math.round(amountUsd * 1e6);
  const testnet = isTestnet();
  const network = testnet ? 'testnet' : 'mainnet';
  const wallet = privateKeyToAccount(readAgentKey());
  const universe = await fetchPerpMeta(network);
  const { assetIndex } = resolveAsset(universe, coin);

  const action = { type: 'updateIsolatedMargin', asset: assetIndex, isBuy, ntli };
  const nonce = nextNonce();
  const signature = await signL1Action({ wallet, action: action as unknown as Record<string, unknown>, nonce, isTestnet: testnet });
  const res = await fetch(testnet ? EXCHANGE_URL.testnet : EXCHANGE_URL.mainnet, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature }),
  });
  const json = (await res.json().catch(() => ({}))) as { status?: string };
  if (!res.ok || json.status !== 'ok') {
    throw new Error(`HL updateIsolatedMargin(${coin} +$${amountUsd}) failed: ${JSON.stringify(json)}`);
  }
}

/**
 * Sign + submit `intent` to HL as an aggressive IOC order, returning the
 * normalized {@link HlOrderResult}. Throws on a rejected order / top-level error
 * (surfaced to the operator); a non-crossing IOC returns filledSz 0 (no fill).
 */
export async function submitOrder(intent: TradeIntent): Promise<HlOrderResult> {
  const testnet = isTestnet();
  const network = testnet ? 'testnet' : 'mainnet';
  const wallet = privateKeyToAccount(readAgentKey());

  // Resolve the asset index + szDecimals from the SAME network we submit to (a
  // testnet rehearsal must use testnet's universe ordering, not mainnet's).
  const universe = await fetchPerpMeta(network);
  const { assetIndex, szDecimals } = resolveAsset(universe, intent.coin);

  // Aggressive IOC price: use the operator's limit if supplied, else cross from
  // the live mid (network-matched). fetchAllMids keys by upper-cased coin.
  const isBuy = intent.side === 'buy';
  let priceBasis = intent.limitPx;
  if (priceBasis == null || priceBasis <= 0) {
    const mids = await fetchAllMids(network);
    const mid = mids[intent.coin.trim().toUpperCase()];
    if (!Number.isFinite(mid) || mid <= 0) {
      throw new Error(`no live mid for ${intent.coin} — cannot price the IOC order`);
    }
    priceBasis = aggressiveIocPrice(mid, isBuy, SLIPPAGE_BUFFER);
  }

  // Floor-format the size, then REFUSE a sub-lot order that floors to 0 (HL would
  // bounce it, and a silently-dropped reduce-only close is dangerous).
  const sizeStr = formatHlSize(intent.sz, szDecimals);
  if (!(Number(sizeStr) > 0)) {
    throw new Error(`order size ${intent.sz} rounds below the ${intent.coin} lot size (szDecimals ${szDecimals}).`);
  }

  const action = buildIocOrderAction({
    assetIndex,
    isBuy,
    priceStr: formatHlPrice(priceBasis, szDecimals),
    sizeStr,
    reduceOnly: intent.reduceOnly,
  });

  const nonce = nextNonce();
  // signL1Action types `action` as a loose Record/array (it hashes by key order);
  // our HlOrderAction is the audited concrete shape — cast at this one boundary.
  const signature = await signL1Action({
    wallet,
    action: action as unknown as Record<string, unknown>,
    nonce,
    isTestnet: testnet,
  });

  const res = await fetch(testnet ? EXCHANGE_URL.testnet : EXCHANGE_URL.mainnet, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`HL /exchange HTTP ${res.status}: ${JSON.stringify(json)}`);
  }

  const parsed = parseOrderResponse(json);
  const filledSz = parsed.filledSize;
  const avgPx = parsed.avgPrice ?? 0;
  const notionalUsd = avgPx * filledSz;

  // Persist only the bounded, meaningful audit bits (status + statuses), not the
  // whole response envelope.
  const statuses = (json.response as { data?: { statuses?: unknown[] } } | undefined)?.data?.statuses ?? null;
  const raw: Record<string, unknown> = {
    status: typeof json.status === 'string' ? json.status : null,
    statuses,
  };

  return {
    avgPx,
    filledSz,
    // A filled IOC can come back short of the requested size (rest canceled).
    partial: filledSz > 0 && filledSz < intent.sz - 1e-9,
    feeUsd: filledSz > 0 ? modelFeeUsd(notionalUsd, 'taker') : 0,
    hlOrderId: parsed.oid != null ? String(parsed.oid) : null,
    raw,
  };
}

/**
 * Place a reduce-only protective trigger order (market-on-trigger) that RESTS on HL
 * and fires when the mark crosses `triggerPx`. `isBuy` is the order side = OPPOSITE
 * the position (a long's protective order sells). `tpsl` picks stop-loss ('sl',
 * default) or take-profit ('tp'). Returns the resting order id (oid). Throws on a
 * rejected action (fail-closed). Reduce-only — it can only CLOSE, never increase.
 */
export async function submitStopOrder(coin: string, triggerPx: number, size: number, isBuy: boolean, tpsl: 'sl' | 'tp' = 'sl'): Promise<{ oid: number | null }> {
  if (!(triggerPx > 0) || !(size > 0)) throw new Error(`submitStopOrder: triggerPx + size must be positive (got ${triggerPx}, ${size})`);
  const testnet = isTestnet();
  const network = testnet ? 'testnet' : 'mainnet';
  const wallet = privateKeyToAccount(readAgentKey());
  const universe = await fetchPerpMeta(network);
  const { assetIndex, szDecimals } = resolveAsset(universe, coin);

  const sizeStr = formatHlSize(size, szDecimals);
  if (!(Number(sizeStr) > 0)) throw new Error(`order size ${size} rounds below the ${coin} lot size.`);
  const triggerPxStr = formatHlPrice(triggerPx, szDecimals);

  const action = buildStopOrderAction({ assetIndex, isBuy, triggerPxStr, sizeStr, tpsl });
  const nonce = nextNonce();
  const signature = await signL1Action({ wallet, action: action as unknown as Record<string, unknown>, nonce, isTestnet: testnet });
  const res = await fetch(testnet ? EXCHANGE_URL.testnet : EXCHANGE_URL.mainnet, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`HL stop order HTTP ${res.status}: ${JSON.stringify(json)}`);
  const parsed = parseOrderResponse(json); // throws on a per-order error; resting → oid
  return { oid: parsed.oid };
}

/**
 * Place a native OCO BRACKET (stop-loss + take-profit, `grouping:'positionTpsl'`) in
 * ONE signed action. `isBuy` = the order side (OPPOSITE the position; both legs close
 * it). HL links the two one-cancels-other + auto-cancels on close. Returns both resting
 * oids. Throws if EITHER leg is rejected (fail-closed — never leave a half-bracket).
 *
 * NOTE: the positionTpsl grouping is a NEW live path — rehearse on HL_NETWORK=testnet
 * (both long + short) before relying on it in production.
 */
export async function submitBracket(coin: string, stopPx: number, tpPx: number, size: number, isBuy: boolean): Promise<{ stopOid: number | null; tpOid: number | null }> {
  if (!(stopPx > 0) || !(tpPx > 0) || !(size > 0)) throw new Error(`submitBracket: stopPx, tpPx + size must be positive (got ${stopPx}, ${tpPx}, ${size})`);
  const testnet = isTestnet();
  const network = testnet ? 'testnet' : 'mainnet';
  const wallet = privateKeyToAccount(readAgentKey());
  const universe = await fetchPerpMeta(network);
  const { assetIndex, szDecimals } = resolveAsset(universe, coin);

  const sizeStr = formatHlSize(size, szDecimals);
  if (!(Number(sizeStr) > 0)) throw new Error(`bracket size ${size} rounds below the ${coin} lot size.`);
  const stopPxStr = formatHlPrice(stopPx, szDecimals);
  const tpPxStr = formatHlPrice(tpPx, szDecimals);

  const action = buildBracketAction({ assetIndex, isBuy, stopPxStr, tpPxStr, sizeStr });
  const nonce = nextNonce();
  const signature = await signL1Action({ wallet, action: action as unknown as Record<string, unknown>, nonce, isTestnet: testnet });
  const res = await fetch(testnet ? EXCHANGE_URL.testnet : EXCHANGE_URL.mainnet, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature }),
  });
  const json = (await res.json().catch(() => ({}))) as { status?: string; response?: { data?: { statuses?: Array<Record<string, unknown>> } } };
  if (!res.ok) throw new Error(`HL bracket HTTP ${res.status}: ${JSON.stringify(json)}`);
  if (json.status !== 'ok') throw new Error(`HL exchange rejected bracket: ${JSON.stringify(json.status ? json : json)}`);
  const statuses = json.response?.data?.statuses;
  if (!Array.isArray(statuses) || statuses.length < 2) throw new Error(`HL bracket: expected 2 order statuses, got ${JSON.stringify(json)}`);
  // Fail-closed: if EITHER leg errored, the bracket is half-placed — surface it.
  for (const s of statuses) { const e = (s as { error?: unknown }).error; if (e) throw new Error(`HL bracket leg rejected: ${String(e)}`); }
  const oidOf = (s: Record<string, unknown>): number | null => {
    const resting = (s as { resting?: { oid?: number } }).resting?.oid;
    const filled = (s as { filled?: { oid?: number } }).filled?.oid;
    return resting ?? filled ?? null;
  };
  // Leg order matches buildBracketAction: [0] = stop ('sl'), [1] = take-profit ('tp').
  return { stopOid: oidOf(statuses[0]), tpOid: oidOf(statuses[1]) };
}

/**
 * Place a resting STOP-ENTRY (trigger-to-open, NOT reduce-only) that fires a market
 * open when the mark crosses `triggerPx`. Sets the coin's leverage FIRST — a resting
 * trigger isn't margin-checked until it fires, so we pin leverage at place time so the
 * fill opens at the intended risk. `isBuy` = the position side (buy=long breakout above
 * mark, sell=short breakdown below mark). Returns the resting oid. Throws on rejection.
 *
 * ⚠ NEW live signing path (reduceOnly:false trigger) — testnet-rehearse long+short first.
 */
export async function submitEntryTrigger(coin: string, triggerPx: number, size: number, isBuy: boolean, leverage: number): Promise<{ oid: number | null }> {
  if (!(triggerPx > 0) || !(size > 0)) throw new Error(`submitEntryTrigger: triggerPx + size must be positive (got ${triggerPx}, ${size})`);
  const testnet = isTestnet();
  const network = testnet ? 'testnet' : 'mainnet';
  const wallet = privateKeyToAccount(readAgentKey());
  const universe = await fetchPerpMeta(network);
  const { assetIndex, szDecimals } = resolveAsset(universe, coin);

  // Validate size to the lot floor BEFORE mutating account leverage — otherwise a
  // sub-lot order would throw here AFTER submitUpdateLeverage already changed the
  // coin's leverage, silently mutating account state on a "failed" place.
  const sizeStr = formatHlSize(size, szDecimals);
  if (!(Number(sizeStr) > 0)) throw new Error(`entry size ${size} rounds below the ${coin} lot size.`);
  const triggerPxStr = formatHlPrice(triggerPx, szDecimals);

  await submitUpdateLeverage(coin, leverage, false); // pin leverage before the resting open
  const action = buildEntryTriggerAction({ assetIndex, isBuy, triggerPxStr, sizeStr });
  const nonce = nextNonce();
  const signature = await signL1Action({ wallet, action: action as unknown as Record<string, unknown>, nonce, isTestnet: testnet });
  const res = await fetch(testnet ? EXCHANGE_URL.testnet : EXCHANGE_URL.mainnet, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`HL entry-trigger HTTP ${res.status}: ${JSON.stringify(json)}`);
  const parsed = parseOrderResponse(json); // throws on a per-order error; resting → oid
  return { oid: parsed.oid };
}

/** Cancel an order by (coin, oid) via the HL `cancel` action. Throws on rejection. */
export async function submitCancel(coin: string, oid: number): Promise<void> {
  const testnet = isTestnet();
  const network = testnet ? 'testnet' : 'mainnet';
  const wallet = privateKeyToAccount(readAgentKey());
  const universe = await fetchPerpMeta(network);
  const { assetIndex } = resolveAsset(universe, coin);

  const action = { type: 'cancel', cancels: [{ a: assetIndex, o: oid }] };
  const nonce = nextNonce();
  const signature = await signL1Action({ wallet, action: action as unknown as Record<string, unknown>, nonce, isTestnet: testnet });
  const res = await fetch(testnet ? EXCHANGE_URL.testnet : EXCHANGE_URL.mainnet, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature }),
  });
  const json = (await res.json().catch(() => ({}))) as { status?: string };
  if (!res.ok || json.status !== 'ok') throw new Error(`HL cancel(${coin} oid ${oid}) failed: ${JSON.stringify(json)}`);
}
