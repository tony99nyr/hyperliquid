# Pre-registration: `event-straddle` live ladder lane

Registered 2026-10-24, before the next event. Historical six fired legs are context only. Count new data only from fires after registration.

## Rule and episode unit

One scheduled event is one episode. Both OCO legs from one print count as one event, even when both fire records exist. Report the lane in nominal R, with slip-aware R shown beside it. Nominal R is net realised P&L divided by the open rung's planned `risk_usd`.

## Pass, kill and size-up bars

- Collect at least **10 fresh events** before a pass decision.
- **Pass** for review only when mean nominal expectancy is at least **+0.15R** across those events.
- **Kill** when mean nominal expectancy is **≤ −0.05R** after 10 fresh events.
- Size up by one risk tier only after the pass bar and when mean realised gap-past-stop is below **0.10R**. Missing gap evidence blocks size-up.

This is a review bar, not permission to arm or trade. The existing slip-aware verdict remains visible and unchanged.
