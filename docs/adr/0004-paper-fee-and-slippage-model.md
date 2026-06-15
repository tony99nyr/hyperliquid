# ADR-0004 — Paper fill fee & slippage model

Status: Accepted (Phase 1a)

## Context

Paper fills must be economically faithful so the weeks-long paper trial actually
validates the live system (ADR-0001). Two cost sources matter: **slippage**
(walking the book away from the top) and **fees** (HL's taker/maker schedule).
If paper P&L ignores these, it will read systematically rosier than live and the
trial is worthless.

## Decision

**Slippage** is modeled, not assumed: `paperFill` fetches a FRESH `l2Book` REST
snapshot each time and runs the PURE `matchIntentAgainstBook()` — a market order
walks real resting levels and gets the true volume-weighted price (including the
adverse fill on a thin book and `partial: true` when liquidity runs out). A
limit order respects its price and may partially fill. Using a *stale* book
would break this, so a fresh fetch per fill is mandatory (ADR-0001).

**Fees** use a documented constant (`paper-fee-model.ts`):

- TAKER = **4.5 bps** (0.045%) of notional
- MAKER = **1.5 bps** (0.015%) of notional

Source: Hyperliquid's published perpetuals base-tier fee schedule (no
referral/staking discounts). Any paper order that fills against the current book
is treated as a **taker** (it crosses the spread) — the honest worst case for a
market-style entry. The bps live in one place so they are easy to retune from
the paper trial and to swap for the real fee once live.

`feeUsd = filledNotionalUsd * (bps / 10_000)`, computed on the *actually filled*
notional (so a partial fill is charged only on what filled).

## Consequences

- Paper P&L reflects real spread/depth at fill time + a conservative taker fee.
- Live fills overwrite this estimate with the actual fee from the HL
  confirmation (Phase 3), so the only paper-vs-live cost gap is the small
  estimate error on fees, never on slippage.
- If the trial shows the 4.5 bps assumption is off (tier discounts, maker
  rebates), retune the constant — one edit, no downstream change.
