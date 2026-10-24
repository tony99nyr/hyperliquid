# Lane performance: UI contract (schemaVersion 1)

The cockpit "Lanes" view renders `GET /api/cockpit/lane-performance`. The CLI
(`pnpm perf:report --json`) returns the same object, so the page and the retro agent
read the same numbers. Types live in `src/lib/performance/lane-performance-business-logic.ts`
(`LanePerformanceReport`) and `lane-performance-forecast-business-logic.ts`
(`ForecastResult`). This doc pins what the UI does with them.

## Routes

| Route | Method | Auth | Body / query | Success | Errors |
|---|---|---|---|---|---|
| `/api/cockpit/lane-performance` | GET | admin PIN cookie, same origin | `?since=<iso>&lane=<id>` (both optional) | `LanePerformanceReport` | 401, 403, 429, 400 (bad `since`), 500 |
| `/api/cockpit/lane-performance/markers/confirm` | POST | admin PIN, same origin | `{ "id": "<marker uuid>" }` | `{ ok: true, marker }` | 400, 401, 403, 404, 500 |

## Shape the UI relies on

- `schemaVersion` must equal `1`. Any other value: show the skew banner and render nothing else.
- Every number is a `Figure` `{ value: number | null, n, unit, source }`. The UI shows
  `value` formatted by `unit`, shows `n` beside it, and shows a dash for `null`. It
  never computes money or R itself.
  - `usd`: `$12.34` (sign shown). `r`, `r_slip`, `r_nominal`: `+0.66R` with a unit tag
    (`R`, `R slip`, `R nominal`). `probability`: `78%`. `per_day`, `days`: plain number.
- `lanes[]`: `id`, `kind` (`live` | `scout`), `verdict` (from canonical logic; show
  as-is), `persistedVerdict` (nullable; when it differs from `verdict`, show a
  "stale card" note), `trades`, `episodes`, `netUsd`, `meanRPerTrade`,
  `meanRPerEpisode`, `timeToVerdict { current, required, remaining, eta, reason }`,
  `series[]` (cumulative points), `markerSplits[]`.
- `overview.live[]` and `overview.scout[]`: cumulative series for the main chart.
- `markers[]`: confirmed markers have `confirmed_at`; the rest are proposed.
- `forecast`: `scope`, `horizonEnd`, `fan[]`, `p5`..`p95`, `pPositive`,
  `expectedMonthly`, `realisedMonthly`, `p95Drawdown30d`, `method`, `seed`, `inputsHash`.
- `snapshots[]`: frozen forecasts with `actual` (null until scored).
- `notes[]`: shown verbatim in an info strip (e.g. "apply migration 0046").

## When things are absent or fail

| Condition | UI behaviour |
|---|---|
| GET 404 | Banner: "The server predates this view. Redeploy or restart it." No other content. |
| GET 401 | The existing cockpit PIN gate handles it; the view shows "Sign in again". |
| GET 5xx or network error | Error strip with the message and a Retry button. Keep the last good report on screen, marked stale with its `generatedAt`. |
| `markers` empty and a note mentions migration 0046 | Change log shows "Markers need migration 0046" instead of an empty list. |
| `snapshots` empty | Forecast table shows "No frozen forecasts yet (the retro freezes one monthly)". |
| `forecast.includedLanes` empty | Forecast panel shows "No active live lanes to forecast" instead of a chart. |
| A lane has no `series` | Card shows the figures with "No resolved trades yet" instead of a sparkline. |
| Marker confirm POST fails | The error shows on that marker row; the row stays "proposed"; nothing else changes. |
| Unknown `unit` or `kind` value | Render the raw value with no formatting; never crash. |

## Not in the contract

The UI never writes markers or forecasts except through the confirm route. Agents
propose markers and freeze forecasts with the CLI (`--write`).
