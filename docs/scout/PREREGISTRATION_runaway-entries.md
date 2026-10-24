# Runaway entry shadow test preregistration

**Registered:** 2026-10-24. **Scope:** shadow analysis only. The live runaway drafter and order path stay unchanged.

## Question and decision

Does the current pullback entry, a continuation entry, or a split entry produce better paired returns after execution costs and stop overshoot?

Make no decision before 10 independent daily episodes. At 10 or more episodes, consider an entry change only when the paired 95% episode-bootstrap confidence interval for improvement excludes zero after overshoot. The direction of improvement must favour the proposed entry. Otherwise retain the current entry and collect more episodes. This test does not authorise a live change.

## Frozen signal and sample

A detection is the existing runaway detector: absolute 24-hour price move at least 5%, with direction set by the move. Prefer historical detections captured in ladder drafts. Candle re-detection uses the same detector and only information available at each hourly close. Do not use later candle highs, lows, or closes to choose a detection.

Collapse every detection on the same UTC calendar day into one episode, including detections across coins. For each strategy and horizon, average the detection-level returns within the episode. This prevents a busy day from increasing the independent sample count. Report constituent detections and episode membership.

## Frozen entry variants

- **Pullback:** rest 3.5% back from the detection mark towards the move, matching the current entry geometry.
- **Continuation:** enter on the first subsequent 1-hour close through the detection extreme, in the direction of the move.
- **Split:** enter half at the detection mark and half at the pullback level. If only one half fills, score the filled half and report the fill fraction. If neither fills, score zero as no-trade.

The pullback and split limits fill only when a later candle trades through their level. Continuation fills at the qualifying 1-hour close. No fill by 48 hours is a no-trade, scored as zero, never as a win. Do not assume a fill from a candle whose only evidence is an ambiguous gap across the level; use the open as the fill when the candle opens beyond the level in the favourable direction. Report this rule in output.

## Outcome and execution assumptions

Use a 5% stop distance from each strategy's actual fill price, in the adverse direction. Measure outcomes from fill price at 48 hours and 7 days. Apply the same entry and exit cost assumptions to every variant. Use 0.05% per side (5 basis points) as the conservative taker-cost proxy. If price gaps beyond the stop, execute at the candle open and record the excess loss as stop overshoot. For a stop touched within a candle, use the stop price; do not infer intrabar ordering between the stop and a favourable extreme.

Report net return as a fraction of filled notional, and show gross return, fees, stop hits, overshoot, fill rate, and no-trade rate. For split entries, weight each filled portion by its actual filled notional. At each horizon, close any still-open position at the last available close at or before the horizon. Missing horizon data is unavailable, not a zero return.

## Comparison and uncertainty

For each pair of variants, calculate the episode-level difference in net return at each horizon, including zero for a strategy that did not fill. Report each episode's paired values. Compute a deterministic 95% percentile confidence interval from 10,000 bootstrap resamples of whole UTC-day episodes, using seed 2401024. Do not resample detections or candles as independent observations.

Report results separately at 48 hours and 7 days. Show the number of episodes, number of detections, per-variant fills, episode mean net return, paired mean improvement, and confidence interval. Keep both horizons visible; do not select the better horizon after seeing results.

## Limits

This is a historical shadow test. It does not reconstruct the live `momentumConfirm` filter, which depends on volume, cumulative volume delta, and book data. The pullback fill rule therefore uses candle-level price touch and can overstate live fills. It also does not model queue position, partial fills beyond the defined split, funding, market impact, or live arming latency. It cannot establish causality or authorise a live drafter change. Record data gaps and detector-source differences in the report.
