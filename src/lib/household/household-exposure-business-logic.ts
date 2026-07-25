/**
 * Household exposure — PURE. The cockpit and iamrossi are two systems in ONE
 * household; a cockpit risk-on trade STACKS on whatever iamrossi is holding.
 * This turns "the operator relays the stance" into an accurate, always-current
 * read of iamrossi's on-chain (Base L2 Safe) crypto exposure.
 *
 * Directional-exposure model (why raw balances suffice): iamrossi is long-or-cash
 * on 8h signals — when long it holds native ETH (since the 2026-07-25 leverage-lane
 * retirement) and/or weETH; both are the same ETH directional delta, so
 * (nativeEth + weETH) × price is the number that matters for correlation + sizing.
 * (Pre-retirement it ran levered weETH loops — the USDC debt was the leverage
 * dimension, never the delta, so the model is unchanged.) Known blind spot: USDC
 * parked in Moonwell/yield reads as $0 stables here (understates dry powder, never
 * the crypto delta).
 *
 * READ-ONLY, awareness + sizing only. NEVER auto-hedges (operator decision).
 */

/** Raw on-chain token balances read from the Safe wallets (human units, not wei). */
export interface HouseholdBalances {
  weEth: number; // weETH held (ETH-beta collateral) — part of the ETH long delta
  /**
   * NATIVE ETH held in the Safes — the other part of the ETH long delta. Since the
   * leverage-lane retirement (2026-07-25) iamrossi holds its ETH exposure as raw
   * native ETH, not weETH; a reader that only counts ERC-20s reads $0 against a
   * multi-ETH position. Includes the BTC Safe's gas dust (same household delta).
   */
  nativeEth: number;
  wBtc: number; // wBTC held — the BTC long delta
  usdc: number; // USDC (dry powder / the debt-side stable)
}

export interface HouseholdMarks {
  ethUsd: number; // use the weETH≈ETH price proxy (staking premium is small; noted)
  btcUsd: number;
}

export interface HouseholdExposure {
  ethExposureUsd: number; // (weETH + native ETH) × ETH price — the household's long-ETH delta
  btcExposureUsd: number; // wBtc × BTC price
  stablesUsd: number;
  /** Net directional crypto beta (long − short; both legs are long here, so a sum). */
  netCryptoBetaUsd: number;
  /** Dominant leg, for the one-line panel read. */
  dominant: 'ETH' | 'BTC' | 'none';
}

/** Fold balances + marks into the exposure summary. PURE. */
export function computeHouseholdExposure(bal: HouseholdBalances, marks: HouseholdMarks): HouseholdExposure {
  const pos = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0); // NaN/neg → 0
  const ethExposureUsd = (pos(bal.weEth) + pos(bal.nativeEth)) * pos(marks.ethUsd);
  const btcExposureUsd = pos(bal.wBtc) * pos(marks.btcUsd);
  const stablesUsd = pos(bal.usdc);
  const netCryptoBetaUsd = ethExposureUsd + btcExposureUsd;
  const dominant: HouseholdExposure['dominant'] =
    ethExposureUsd < 1 && btcExposureUsd < 1 ? 'none' : ethExposureUsd >= btcExposureUsd ? 'ETH' : 'BTC';
  return { ethExposureUsd, btcExposureUsd, stablesUsd, netCryptoBetaUsd, dominant };
}

/**
 * How much a proposed cockpit trade would STACK on the household. Positive =
 * adds correlated same-direction beta (the thing to flag); a cockpit SHORT of a
 * coin the household is long REDUCES net household delta (a partial hedge). PURE.
 * `cockpitNotionalUsd` is signed by side (long +, short −) on the given coin.
 */
export function stackingUsd(
  exposure: HouseholdExposure,
  coin: 'ETH' | 'BTC',
  cockpitSignedNotionalUsd: number,
): { householdLegUsd: number; combinedUsd: number; addsCorrelation: boolean } {
  const householdLegUsd = coin === 'ETH' ? exposure.ethExposureUsd : exposure.btcExposureUsd;
  const combinedUsd = householdLegUsd + cockpitSignedNotionalUsd;
  // Adds correlation when the cockpit leg pushes further from zero in the same
  // direction the household already leans (household is long, cockpit also long).
  const addsCorrelation = householdLegUsd > 0 && cockpitSignedNotionalUsd > 0;
  return { householdLegUsd, combinedUsd, addsCorrelation };
}
