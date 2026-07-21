/**
 * Household exposure (I/O) — reads iamrossi's on-chain crypto exposure from its
 * Base L2 Safe wallets, READ-ONLY. This is PUBLIC blockchain state (the same
 * pattern the cockpit uses to watch HL leader wallets, pointed at Base) — no
 * iamrossi API, no shared secret, no coupling to their deployment.
 *
 * Config (all optional; unset ⇒ the read returns null and callers show nothing):
 *   IAMROSSI_SAFE_ETH   — the ETH Safe wallet address (holds weETH)
 *   IAMROSSI_SAFE_BTC   — the BTC Safe wallet address (holds wBTC)
 *   BASE_RPC_URL        — a Base RPC (defaults to the public https://mainnet.base.org)
 *   BASE_WEETH_ADDRESS / BASE_WBTC_ADDRESS / BASE_USDC_ADDRESS — token overrides
 *     (default to Base-mainnet canonical addresses).
 *
 * Fail-soft throughout: a bad RPC / missing config yields null, never a throw.
 * NEVER writes, NEVER trades — awareness + sizing only.
 */

import 'server-only';
import { createPublicClient, http, getAddress, erc20Abi, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { computeHouseholdExposure, type HouseholdExposure } from './household-exposure-business-logic';

// Base-mainnet canonical token addresses (overridable via env).
const DEFAULTS = {
  weeth: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A', // weETH on Base
  wbtc: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC on Base (Coinbase-wrapped BTC — the dominant Base BTC; iamrossi holds this, NOT the legacy WBTC)
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
} as const;

function envAddr(name: string): `0x${string}` | null {
  const v = process.env[name]?.trim();
  if (!v) return null;
  try {
    return getAddress(v);
  } catch {
    // Configured but invalid (bad checksum/length) — warn rather than silently
    // dropping the Safe from the household read.
    console.warn(`[household] ${name} is set but not a valid address — ignoring.`);
    return null;
  }
}

export interface HouseholdReadResult extends HouseholdExposure {
  /** ISO of the read; null-returning callers distinguish "unconfigured" from "zero". */
  readAt: number;
  source: 'onchain-base';
}

/**
 * Read iamrossi's Safe balances on Base and fold into the exposure summary.
 * `marks` supplies live ETH/BTC USD prices (the caller passes HL mids). Returns
 * null when unconfigured or the chain read fails.
 */
export async function readHouseholdExposure(marks: { ethUsd: number; btcUsd: number }): Promise<HouseholdReadResult | null> {
  const safeEth = envAddr('IAMROSSI_SAFE_ETH');
  const safeBtc = envAddr('IAMROSSI_SAFE_BTC');
  if (!safeEth && !safeBtc) return null; // nothing to watch → callers render nothing

  const weeth = envAddr('BASE_WEETH_ADDRESS') ?? getAddress(DEFAULTS.weeth);
  const wbtc = envAddr('BASE_WBTC_ADDRESS') ?? getAddress(DEFAULTS.wbtc);
  const usdc = envAddr('BASE_USDC_ADDRESS') ?? getAddress(DEFAULTS.usdc);
  const rpc = process.env.BASE_RPC_URL?.trim() || 'https://mainnet.base.org';

  try {
    // Tight timeout/retry so a slow/hostile RPC can't stall the scout wake (default
    // viem is ~10s×3). Fail-soft to null past the budget.
    const client = createPublicClient({ chain: base, transport: http(rpc, { timeout: 3_000, retryCount: 1 }) });
    const bal = async (token: `0x${string}`, holder: `0x${string}` | null, decimals: number): Promise<number> => {
      if (!holder) return 0;
      const raw = (await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] })) as bigint;
      return Number(formatUnits(raw, decimals));
    };
    // weETH & USDC live in the ETH Safe; cbBTC in the BTC Safe (per iamrossi's split).
    // ASSUMPTION: collateral sits IN-WALLET (balanceOf). If iamrossi ever SUPPLIES
    // weETH into Morpho Blue (internal accounting), balanceOf returns only idle
    // weETH and this UNDERSTATES the ETH delta — a silent low read, never a wrong
    // direction. Reading supplied-collateral needs the position-manager decode
    // (the coupling we avoid). Verified in-wallet at build time ($14,097 ETH).
    const sameSafe = safeEth && safeBtc && safeEth === safeBtc;
    const [weEth, usdcEth, wBtc, usdcBtc] = await Promise.all([
      bal(weeth, safeEth, 18),
      bal(usdc, safeEth, 6),
      bal(wbtc, safeBtc, 8),
      sameSafe ? Promise.resolve(0) : bal(usdc, safeBtc, 6), // don't double-count one wallet's USDC
    ]);
    const exposure = computeHouseholdExposure({ weEth, wBtc, usdc: usdcEth + usdcBtc }, marks);
    return { ...exposure, readAt: Date.now(), source: 'onchain-base' };
  } catch {
    return null; // RPC / decode failure → awareness simply absent this cycle
  }
}
