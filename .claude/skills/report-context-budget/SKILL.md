---
name: report-context-budget
description: >-
  Record Claude's approximate self-reported context-usage percent and zone to the
  cockpit so the user is never caught near a context limit mid-trade. Use when the
  user says "report context", "how full are you", "context check", "log your
  budget", or periodically during a long session. Tiny, single-purpose — it only
  writes the gauge.
---

# report-context-budget

Single purpose: write an approximate context-usage percent (0–100) and its
classified zone (ok < 60 ≤ warn < 85 ≤ critical) to the `context_gauge` table, so
the cockpit ContextGauge can warn the user before Claude runs low mid-trade.

This is a **safety cue, not a meter** — the percent is approximate and
self-reported by Claude.

## Protocol

1. Estimate your current context usage as a percent (be honest and slightly
   conservative — round up when unsure).
2. Run: `pnpm skill:report-context --session <id> --pct <0-100>`.
3. The script classifies the zone (PURE `classifyContextZone`) and writes the
   gauge row. Relay the zone to the user.
4. If the zone is `warn` or `critical`, tell the user to finish the in-flight
   decision and consider starting a fresh session before taking any new action.

## Guardrails

- Writes only the gauge row — no analysis, no orders.
- Re-report after large analysis steps during a long session.
