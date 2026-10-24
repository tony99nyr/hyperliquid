# Regime split expectancy, preregistered 2026-10-24

## Hypothesis

Expectancy varies by the existing bullish, bearish, and neutral market regime within each live ladder and scout lane.

## Data and timing

Use closed live `ladder_outcomes` and resolved scout hypotheses with finite net R. Classify each entry using the existing market regime detector on completed four-hour candles available before entry. Keep unknown when the entry time, coin, or candle history is missing. Count each ladder or scout hypothesis once, and report a separate count of independent five-day entry episodes.

## Test

Report count, independent episodes, mean net R, and total net R for each lane and regime. Include unknown coverage. Mark every cell with fewer than five observations as thin. The study is descriptive and has no kill bar.
