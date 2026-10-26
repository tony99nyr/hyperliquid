# Pre-registration: capital-add rule for the live desk

Registered 2026-10-26, before the first monthly forecast is frozen. Source: the 2026-10-26 research lane (idea "make the track record the product"). The rule decides only **when** the operator may add capital. The operator still decides **whether** and **how much**, within the step cap below.

## Why

At about $1,000 of equity, the desk earns tens of dollars a month. Capital is the largest lever, but adding it to an unproven process scales losses as well as wins. This rule ties capital to forecasts that were frozen before each month started.

## Inputs

- The monthly live forecast that `desk-retro` freezes on the first retro of each month (`pnpm perf:forecast --freeze --write`, scope `live`).
- Its score after month end (`pnpm perf:forecast --score --write`): realised live P&L from `ladder_outcomes` resolved inside the horizon.
- Realised gap-past-stop per resolved live episode, from the ladder outcome ledger.

The first qualifying forecast is the November 2026 freeze (first retro, 2026-11-02). Earlier snapshots do not count.

## A month qualifies only when all of these are true

1. A live forecast was frozen at the first retro of the month, before the month's outcomes.
2. Realised live P&L for the month is inside that forecast's P5 to P95 band.
3. At least **2 resolved live episodes** fell inside the month. A month with fewer is **neutral**: it does not qualify and does not reset the count.
4. Mean realised gap-past-stop for the month's episodes is below **0.10R**. Missing gap evidence fails this check.
5. The account circuit breaker did not halt new entries during the month.

## Rule

- **Add allowed** after **3 consecutive qualifying months**, AND when the summed realised live P&L of those 3 months is above zero.
- A month that fails check 2, 4 or 5 **resets** the count to zero.
- **Step cap:** one add per qualifying run, at most **+50% of current equity**. After an add, the count restarts at zero.
- **Risk stays at about 1% of the new equity per campaign.** The add must not raise the risk fraction, the book-heat cap or the arm caps.
- **Earliest decision:** the first retro of February 2027 (November, December and January qualify).

## Kill

- If 2 of any 3 consecutive scored months land **below P5**, stop forecasting-for-capital and review the forecast method before any add. The known weakness is that the episode bootstrap gives an optimistic downside on a small sample.
- If live equity falls 20% below its peak since registration (Performance tab equity curve), no add is allowed until a fresh run of 3 qualifying months. Do not record account figures in this public doc.

## Not in scope

This rule does not authorise a trade, an arm or a transfer. Deposits are an operator action outside the system.

## Count log

The first retro of each month appends one line here: the month, the result (qualifying, neutral or reset), the reason, and the running count. Do not edit the rule above.

- (no scored months yet)
