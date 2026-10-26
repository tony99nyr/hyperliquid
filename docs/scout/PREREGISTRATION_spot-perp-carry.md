# Pre-registration: `spot-perp-carry` study

Registered 2026-10-26, before any replay run. Research only. The study never trades, arms or calls the HL exchange endpoint.

## Hypothesis

An earlier verdict said funding carry "cannot be built below $5k, no spot leg". HL lists spot BTC (UBTC), ETH (UETH), HYPE and possibly SOL (USOL). A small desk can hold the spot coin and short the same perp for equal notional. The position is delta-neutral and collects perp funding when funding is positive. The hypothesis is that this earns a net return that clears the bar below after real fees and basis.

## Benchmark bug (context, not changed here)

`src/lib/scout/funding-carry-business-logic.ts::fundingCarryBenchmark` picks the entry side from the first non-zero funding row. It then breaks out of the loop at the first row where funding goes against that side, and never re-enters. A series that flips once and recovers is scored as if the trade ended at the flip. The scout carry lane (`lane-scorecard-service.ts`, Lane B) therefore understates a re-entering carry. This study does not touch that code. The new model lives in `src/lib/backtest/spot-perp-carry-business-logic.ts`.

## Data

- HL `fundingHistory` per coin: BTC, ETH, HYPE, SOL. Hourly rows.
- HL 1h perp candles (`candleSnapshot`, coin name) and 1h spot candles (`candleSnapshot`, spot name `@index` from `spotMeta`).
- HL `meta` for `maxLeverage` (maintenance margin = 1 / (2 x maxLeverage)).
- All reads go through `scripts/_study-io.ts`. `spotMeta` is added to its read-only allow-list.
- A coin starts when its first spot candle exists, plus a 24h warm-up for the signal. A coin with no spot market is excluded and reported.

## Fees

HL base tier (14-day volume under $5M, no staking discount): perp taker 4.5 bps, spot taker 7 bps. Source: current secondary summaries of the HL fee schedule (the official page was not directly fetchable). Every entry and every exit pays both: round trip = 2 x (7 + 4.5) = 23 bps of notional, plus basis. Funding is paid at the perp mark price. No maker fills, no rebates. Idle capital earns nothing.

## Exact rule

State per coin. Position is flat or on.

- Signal `m24` at funding row `i` = mean of the hourly funding rates of rows `i-23 .. i`.
- Flat to on: when `m24 > +0.00001` per hour (about 8.8% APR).
- On to flat: when `m24 < -0.000005` per hour (about -4.4% APR).
- Between the two thresholds, hold the current state. Re-entry is free and unlimited.
- Execution: a decision at row time `t` fills at the open of the 1h candle starting at `t + 1h`, for both legs. No look-ahead.
- Funding rows `i+1 .. k` are earned for an entry decided at row `i` and an exit decided at row `k`. The row at the exit fill time is not earned.
- If either leg has no candle at the fill hour, defer the entry by one hour. For an exit, use the last known price.
- Size: spot notional `N0` at entry, short perp of equal quantity. Quantity is fixed for the trade. No rebalancing.
- Capital = `N0` + `N0 / 3` (perp margin at 3x) = 1.3333 `N0`. Capital is constant and counted for the full period, in market or not.
- Hourly mark-to-market equity = cumulative funding - cumulative fees + spot P&L - perp short P&L. The basis at entry and exit comes from the real spot and perp prices.

## Metrics

- Net APR on capital: total net P&L / capital, divided by years of coverage (first replay hour to last).
- Calendar-year net P&L (sign). A year counts only with at least 60 days of coverage.
- Worst rolling 30-day (720 h) change in mark-to-market equity, as a fraction of capital.
- Time in market, number of round trips.
- Margin need for a 30% rally at 3x: short notional grows to 1.3 `N0`. Report equity left in the perp account, the top-up to restore 3x, the top-up to stay above maintenance margin, and the rally that liquidates an isolated 3x short. Also report the largest historical rally from entry inside any held trade.
- Reference (non-binding): the same model always on, with no signal. This is for context only.

## Bar

A coin or the basket passes only if all three hold:

1. Net APR on capital at least **6%**.
2. Positive in at least 3 of 4 calendar years. With `n` years of data: `n = 4` needs 3 positive, `n = 3` needs 3, and `n < 3` is unmeasurable.
3. Worst 30-day window above **-1%** of capital.

Basket = equal weight over the coins with data, each at the same capital. A basket needs at least 2 coins.

## Verdict and kill rule

- **FAIL** if any measurable test fails. This is the kill rule.
- **INSUFFICIENT** if no measurable test fails but the year test is unmeasurable (fewer than 3 years with data), or if coverage is under 365 days.
- **PASS** only if all three tests pass with enough data.

Report the number of years with data next to every verdict. A PASS is a review result, not permission to trade. Do not change thresholds or the bar after seeing data. Any parameter sensitivity run is labelled non-binding.

## Amendment 1 (2026-10-26, after the data-access limit, before any binding result)

A first smoke run showed that HL `candleSnapshot` serves only the most recent 5000 candles per series. At 1h that is about 208 days, which is not enough for a calendar-year test. The study therefore uses **4h** candles (about 830 days). The bar, the signal thresholds, the fees and the funding data do not change. Two details change with the coarser step:

- A decision made at funding row `t` is re-checked every hour. It fills at the first 4h candle open at or after `t + 1h` at which the decision still holds. Both legs fill at that open.
- Funding and mark-to-market use the open of the 4h candle that contains the funding hour (a price at most 4h old).

The discarded 1h smoke run covered only April to October 2026. Its numbers were not used to choose any parameter.

## Amendment 2 (2026-10-26, data-quality rule, before any binding result)

The first 4h run showed placeholder spot prints right after listing (UBTC printed 6,969,696 and 100,002,060 against a perp near 95,000). This is a data error, not a result. The study now treats a spot candle as valid only if its open is within 10% of the perp open in the same bucket. A coin starts at the first valid candle that begins a run of 42 valid 4h candles (7 days). Later invalid candles are dropped as missing. The rule applies to every coin the same way. Counts of dropped candles are printed. The bar and the signal do not change.
