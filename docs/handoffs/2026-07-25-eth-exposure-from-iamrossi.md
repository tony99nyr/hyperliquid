# Handoff: ETH exposure moves from iamrossi leverage lane → HL armed ladder

**Date:** 2026-07-25
**From:** iamrossi trading system session (Tony's decision)
**Status:** iamrossi leverage lane is OFF. Nothing armed on HL yet — that is the follow-up this note requests.

## What happened

The iamrossi Base-L2 leverage lane (Morpho weETH-collateral / WETH-debt loop) was retired today:

- **2026-07-24 incident**: a SELL-triggered leverage exit was blocked — the weETH→WETH funding swap dead-ended on a depleted Uniswap pool (5.5 WETH depth) and the flat oracle guard. Fixed same-day (exit-bound-guarded Aerodrome funding swap, iamrossi commit `2e444d92`); position exited cleanly 2026-07-25 04:05.
- **The leak that decided it**: on-chain accounting showed every leverage cycle pays 2–3% round-trip through the thin weETH/WETH volatile pool. Measured: ~$643 on the final exit alone; ~$1,200–1,600 cumulative since April on ~$78k notional; ~$1,100+ in July alone (3 cycles). On top of whipsaw timing losses (entered ~$1,935 avg Jul 21–22, exited $1,853), realized edge was negative.
- **Decision**: `LEVERAGE_INTEGRATION_ENABLED=false` in Vercel prod (position flat, module still deployed, reversible). ETH tactical exposure should instead come from an **HL ETH armed ladder** — fees are ~2.5–4.5 bps/fill + funding vs 2–3% per Base round-trip, ~50–100× cheaper.

## What this asks of the hl-cockpit session

Prepare an **ETH armed ladder** proposal for Tony to review and arm via the cockpit (live arming stays Tony-manual per deployment topology). Constraints that already bind (do not re-litigate):

- **Risk-first sizing + ATR stops** per the position-setup redesign; **NO auto-adds** (adds ≤ 2 is the discriminator — martingale-shaped laddering is exactly what got rejected).
- **Armed-ladder capability**: pre-authorized rungs fire live only through the approval flow; P1 is behind `LADDER_LIVE_ENABLED` (currently OFF). P0 native brackets were in flight — check status before proposing execution mechanics.
- Paper/live seam: this WSL box is PAPER; live is manual via cockpit popup.

Open parameters for Tony (his risk calls, needs live prices at proposal time): total ETH exposure to replace (the retired lane ran ~$8–16k notional at 1.99x — net delta ≈ 4.4–8.8 ETH-equivalents, but ladder sizing should be derived from risk budget, not from matching the old lane), rung band, rung count/spacing, stop distance.

## Context pointers (iamrossi side)

- Exit-bound guard geometry: `src/lib/defi/protocols/leverage-exit-bound.ts` (iamrossi) — relevant if the lane is ever revived.
- Undiscovered-at-the-time cheap venue: Aerodrome Slipstream weETH/WETH (`0xbD3cd0D9d429b41F0a2e1C026552Bd598294d5E0`, 0.0085% fee, ~2,500× in-range depth) — only matters if leverage returns.
- The iamrossi wallet currently holds ~8.5 ETH native + 1.4 weETH, unlevered; its own SELL signal retries on the next cron.
