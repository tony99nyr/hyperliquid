# Pre-registration: `hip3-earnings-straddle` replay

Registered 2026-10-26, before any replay result exists. Candle data were only inspected for history depth and listing dates. No event return has been computed.

## Hypothesis

The frozen `event-straddle` rule (see `PREREGISTRATION_event-straddle.md`, `scripts/event-straddle-prep.ts`, `src/lib/backtest/straddle-exit-shadow-business-logic.ts`) has positive expectancy on HIP-3 single-stock perps around earnings releases. Earnings give many more events per quarter than macro prints.

## Frozen rule (unchanged from the live template)

- Reference: the last price before the print.
- Gate: 1.0% above and below the reference. Stop at the reference. Nominal 1R is the gate-to-reference distance.
- Plain OCO. The first completed candle close through a gate fills that side. A close through both gates, or a gap past the sibling, is not a fill. No sibling re-presentation is modelled.
- Window: hot from print minus 15 minutes, expiry at print plus 24 hours.
- Management rungs: stop to entry at +0.7R, reduce 34% at +1R, reduce 50% of the remainder at +2R, 0.8R trailing stop from +1.2R. Levels are measured from the gate. A rung fires on a candle close and executes at the next candle open. The resting stop is checked first on each candle, and a gap fills at the adverse open.
- The momentum-stall rung is omitted. A candle-only replay cannot rebuild its volume, CVD and book votes.
- Time exit (study choice, because an earnings position must resolve): the remainder closes at the open of the first candle at or after print plus 24 hours. The live template leaves that close to the operator.

## Data

- Venue: Hyperliquid HIP-3 dex `xyz` (trade.xyz). Coins are named `xyz:TICKER`. Queries are `meta` with `dex: "xyz"`, `metaAndAssetCtxs` with `dex: "xyz"` and `candleSnapshot` with `coin: "xyz:TICKER"`. All are read-only info calls through `scripts/_study-io.ts`.
- Interval: **1h**. HL returns only the most recent 5000 candles per interval, so 15m reaches back to about 2026-09-04 (about 52 days) and covers almost no earnings. 1h reaches back to 2026-04-01 and covers the April to May, July to August and October seasons. The rule asks for a 15m close. A 1h close is a coarser gate check. A 15m run on the events it covers is shown as a non-binding sensitivity.
- Universe: single-stock `xyz` perps with 24h notional volume of at least $5M on 2026-10-26 and a first 1h candle on or before 2026-05-04. Indices, commodities, FX and ETFs are out. Coins: TSLA, META, GOOGL, AAPL, AMZN, MSFT, AMD, PLTR, INTC, NVDA, MU, SNDK, CRWV, ORCL, CRCL, MSTR, MRVL, CBRS.
- Events: `data/scout/hip3-earnings-events.json` (public sources listed per row). The list was fixed before the replay. Events after 2026-10-24 are excluded for lack of candles.
- Reference price: the close of the last 1h candle that ends at or before the print time. For an after-close print this is the price at the 16:00 ET cash close. For a before-open print it is the price at the start of the UTC hour before the print.
- A candle that contains the print can trigger. Its close is post-print.

## Metric

R per event, nominal. An event with no fill is 0R and is counted. An event is eligible when the reference candle exists and at least 80% of the hourly candles from the reference to print plus 24 hours exist. Ineligible events are listed and excluded.

Costs: 9 bps taker on the entry notional and on each exit leg, plus the overshoot from filling at the trigger candle close. Entry price is that close, so overshoot is the close minus the gate. R divides price P&L per unit by the gate-to-stop distance.

## Bar and kill rule

PASS needs all of:

1. Mean R across eligible events, no-fills as 0R, at least **+0.2R** after costs.
2. **n at least 30** eligible events.
3. Mean R still **positive with the top 3 events removed**.

Verdict is INSUFFICIENT when n is below 30, whatever the mean. Otherwise FAIL if any condition fails. FAIL is the kill. The bar is not changed after the data are seen.

## Non-binding extras

Fill count, win rate, mean R of filled events, an event-level bootstrap 95% interval (10,000 resamples, fixed seed), splits by before-open and after-close, by coin and by season, a 1.5% gate run and a 15m run. These do not change the verdict.

## Data limits (to repeat in the report)

- The cash market is closed overnight and at weekends. The HIP-3 oracle for a stock perp keeps a price while the cash market is shut, from the deployer's feed. How it behaves then is not documented in the API. The replay treats all hours as tradable.
- After-close prints are traded in thin hours. Book depth is not in candle data. A 9 bps fee plus close-fill overshoot may understate real slippage on thin books.
- Candles are missing when no trade occurs. Gaps are counted, not filled.
- The 5000-candle cap limits history to three seasons. Many events share one market regime.
- Event times for aggregator-sourced rows follow each company's usual practice.
- Hourly closes can miss an intra-hour round trip and fill later or not at all.
