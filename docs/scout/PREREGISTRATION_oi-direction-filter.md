# OI direction filter, preregistered 2026-10-24

## Hypothesis

Htf-trend breakout trades entered while open interest (OI) rises outperform trades entered while OI falls.

## Data and timing

Use only completed trades from `replayHtfPortfolio`, with its existing fees, slippage, funding, and portfolio cap. Join `market_snapshots` by coin and entry time. Compare the last snapshot available before the breakout signal close with one at least 24 hours earlier. A snapshot must be no older than six hours. Exclude flat, missing, and stale pairs. Never derive a signal from live closes.

## Test

Compare the rising-OI subset with the complete eligible replay cohort. Report mean net R, independent five-day entry episodes, winner retention, and excluded coverage. The frozen rule keeps a trade only when OI rose.

## Kill bar

At 20 or more rising-OI trades, kill the filter if their mean net R is below +0.2R or if the filter removes more than half of eligible winners. Below 20 trades, report insufficient evidence.
