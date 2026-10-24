# Cross-venue funding veto, preregistered 2026-10-24

## Hypothesis

Htf entries on the crowded side of an unusually high Hyperliquid (HL) funding premium underperform other htf entries.

## Data and timing

Use completed htf replay trades only. Use archived HL `predictedFundings` observations captured before each breakout signal close. Use Binance historical funding from `data.binance.vision`, published before the signal. Express both rates per eight hours. Mark a long crowded when the HL-minus-Binance premium is at least +0.0001. Mark a short crowded when it is at most -0.0001. Require both observations within eight hours before the signal. Missing data stays unclassified.

## Test

Compare mean net R of vetoed and kept classified trades, with trade counts and independent five-day entry episodes. Keep the historical replay unchanged. The veto is a counterfactual report only.

## Kill bar

Kill the proposed veto unless vetoed trades average at least 0.3R below kept trades. Report insufficient evidence when either group has fewer than five independent episodes.
