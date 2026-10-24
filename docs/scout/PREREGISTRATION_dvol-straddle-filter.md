# DVOL straddle filter, preregistered 2026-10-24

## Hypothesis

Straddles opened when Deribit DVOL is cheap relative to 30-day realised volatility earn more net R than rich-vol straddles.

## Data and timing

Use BTC and ETH filled event-straddle outcomes with a known opening timestamp, underlying, and slip-aware net R. Use Deribit's public `get_volatility_index_data` for the matching currency. Compute 30-day realised volatility from the 30 complete UTC daily closes available before each print. Use the last DVOL observation at or before the print, with a maximum age of one hour. Compare `DVOL / realised volatility`. Exclude rows with missing or stale data. Count one print as one independent event, combining same-print legs before terciles.

## Test

Rank eligible events by the ratio across both assets. Compare the lowest and highest terciles by mean net R. Break ties by print timestamp and event identifier. Report coverage, both sample sizes, means, and their difference. Do not choose a threshold after seeing outcomes.

## Kill bar

At 15 or more independent prints in each tercile, kill the filter unless cheap-vol mean net R exceeds rich-vol mean net R by at least 0.3R. Below that count, report insufficient evidence.
