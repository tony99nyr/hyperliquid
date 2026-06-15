# `rated-wallets.json` — Schema

Consolidated Hyperliquid wallet ratings, merged from the four philosophy bake-offs into a single
dataset that the **Wallet Copy-Monitor** tool (`/tools/wallet-copy-monitor`) reads. Read-only
decision-support — nothing here executes a trade.

Regenerate with:

```bash
node scripts/analysis/wallet-rating/consolidate-rated-wallets.mjs
```

## Sources

| Philosophy    | Source file                                                              | What it grades |
|---------------|--------------------------------------------------------------------------|----------------|
| `consistency` | `scripts/analysis/wallet-rating/hl-consistency/shortlist-hl-consistency.json` | Risk-adjusted, low-variance, persistent returns |
| `skill`       | `scripts/analysis/wallet-rating/hl-skill-shortlist.json`                  | Persistent skill / anticipation, regime robustness |
| `survivor`    | `scripts/analysis/wallet-rating/hl-survivor-results.json`                 | Capital preservation, tail safety, blow-up avoidance |
| `copyability` | `data/backups/hyperliquid-study/copyability-shortlist.json`              | Copy-trading fitness: hold time, add-depth/reserve, position size, asset mix |

## Top-level shape

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-14T...Z",
  "description": "...",
  "philosophies": ["consistency", "skill", "survivor", "copyability"],
  "watchWindowEdt": { "startHour": 8, "endHour": 22 }, // user's "hours I can watch", America/New_York
  "knownFlags": ["DISQUALIFIED", "EXTREME_WIN_RATE", ...],
  "count": 58,
  "wallets": [ /* WalletRating[] sorted by composite desc */ ]
}
```

`watchWindowEdt` is configured at the top of `consolidate-rated-wallets.mjs`
(`WATCH_WINDOW_EDT`). `daytimeActivePct` is computed against it, and wallets whose
share falls below `OVERNIGHT_THRESHOLD` (0.4) get the `TRADES_OVERNIGHT_EDT` flag.
Supports wrap-around windows (e.g. `{startHour:22, endHour:6}`).

## `WalletRating`

| Field             | Type                              | Notes |
|-------------------|-----------------------------------|-------|
| `address`         | string (lowercase 0x…)            | HL wallet address (the join key) |
| `short`           | string                            | `0x31de…13f2` display form |
| `displayName`     | string \| null                    | Leaderboard display name if known |
| `grades`          | `Record<philosophy, {grade, score10}>` | Only philosophies that rated this wallet are present. `grade` = letter (A–F), `score10` = 0–10 |
| `composite`       | number \| null                    | Mean of available `score10` values (0–10) |
| `flags`           | string[]                          | Deduped badges + risk flags (see below). `DISQUALIFIED` sorted first |
| `metrics`         | object (best-available)           | See metrics table |
| `sources`         | philosophy[]                      | Which philosophies rated this wallet (sorted) |
| `tradingActivity` | object \| null                    | EDT trading-hours profile (see below). `null` when no cached fills (also flagged `NO_FILL_DATA`) |
| `leaderboardTop`  | boolean (optional)                | On the public HL leaderboard |
| `anticipationLabel` | string (optional)               | From skill lens: `anticipating` / `reacting` / etc. |
| `topCoins`        | string[] (optional)               | Most-traded coins (from copyability) |
| `worstOpen`       | object (optional)                 | `{ coin, peakNotionalUsd, adds }` — worst live open position |

### `metrics` (only present when the underlying source provided it)

| Key                   | Meaning |
|-----------------------|---------|
| `sharpe`              | Annualized Sharpe |
| `maxDrawdownFrac`     | Max drawdown as fraction (0–1) |
| `winRate`             | Round-trip win rate (0–1) |
| `profitFactor`        | Gross profit / gross loss |
| `worstLossVsMedianWin`| Worst loss relative to median win (tail asymmetry) |
| `aggregatePnlUsd`     | Aggregate net PnL over study period (USD) |
| `totalReturn`         | Study-period return (fraction) |
| `majorsShare`         | Share of volume in major coins (0–1) |
| `medianHoldHours`     | Median position hold time (hours) |
| `maxAddDepth`         | Max number of adds to a single position (martingale signal) |
| `medianAddDepth`      | Median adds per position |
| `reserveMultiple`     | Peak notional / reserve (size discipline) |
| `liquidations`        | Count of liquidations |
| `nFills`              | Total fills analyzed |
| `distinctCoins`       | Distinct coins traded |
| `subMinuteFrac`       | Fraction of sub-minute trades (scalping signal) |
| `openPeakVsMedianPeak`| Current open peak vs median peak (live-deep-stack signal) |
| `avgAccountValue`     | Average account value (USD) |
| `accountAgeDays`      | Account age (days) |
| `memeShare`           | Share of volume in memecoins (0–1) |

### `tradingActivity` (EDT, from cached fills in `data/backups/hyperliquid-study/fills/`)

| Key                | Meaning |
|--------------------|---------|
| `hourHistogramEdt` | `number[24]` — share of fills per EDT hour (index = hour 0–23), DST-correct via `Intl` |
| `daytimeActivePct` | Share of fills inside `watchWindowEdt` (0–1) |
| `overnightPct`     | Share outside the window (0–1) |
| `peakHoursEdt`     | Top EDT hours by fill share (most active first) |
| `nFillsAnalyzed`   | Fill count used |

Only the 20 wallets with cached fills have this; the rest are `null` + `NO_FILL_DATA`.
The post-POC rating refresh can backfill the remaining wallets' fills.

## Flags / badges

`knownFlags` enumerates everything observed across sources. Risk flags the UI color-codes red:
`DISQUALIFIED`, `NO_STOPS`, `DEEP_MARTINGALE`, `DEEP_DRAWDOWN`, `FAT_WORST_LOSS`,
`LIVE_UNDERWATER`, `RIDE_OR_LIQUIDATE`, `BLOW_UP_RISK`, `LIVE_DEEP_STACK`,
`EXTREME_WIN_RATE`, `THIN_ALT_TRADER`, `SUB_MINUTE_SCALPER`. Positive/neutral badges:
`CLEAN_BOOK`, `PERSISTENT_SET`, `VAULT_LED`, `PROVISIONAL_NO_FILLS`,
`ANTICIPATION_UNMEASURED`, `REACTS_NOT_ANTICIPATES`.
