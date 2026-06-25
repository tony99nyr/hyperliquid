# ADR-0002 — Two independent realtime transports

Status: Accepted (Phase 0)

## Context

The cockpit must live-render, on desktop AND phone, two very different kinds of
data: high-frequency ephemeral market data (price / order book / trades) and
durable, low-frequency trade state (Claude's analysis, hypotheses, fills,
positions, P&L, health, the context gauge). They have opposite requirements:
market data is firehose-volume and disposable; trade state is the source of
truth and must survive reloads and be auditable.

Vercel serverless functions cannot hold long-lived websocket connections, so a
server-side HL socket relay is not an option.

## Decision

Two independent transports:

1. **Market data → browser directly.** The HL websocket
   (`wss://api.hyperliquid.xyz/ws`) connects from the client. High-frequency,
   ephemeral, **never stored**. (Phase 1: `src/lib/ws/`.)

2. **Cockpit state → Supabase Postgres realtime.** Claude's skills write rows
   via the server **service-role** client; Supabase realtime pushes them to the
   browser, which subscribes per session. Durable, low-frequency, the source of
   truth. (Tables in `supabase/migrations/0001_init.sql`.)

### Security

- The **service-role key is server-only** and MUST NOT reach the client bundle
  (`supabase-server.ts` imports `server-only`).
- The browser uses the **anon key** with **RLS `select`-only** — it can read
  live trade state but cannot write. All writes go through the service role.
- The cockpit route is gated by the vendored admin-PIN.

## Consequences

- No server holds a socket; the firehose stays client-side and free.
- Trade state is queryable/auditable in Postgres and replays on reload.
- `REPLICA IDENTITY FULL` + the `supabase_realtime` publication are required on
  every cockpit table so UPDATE/DELETE realtime payloads carry full rows.
- Market data and trade state can never be confused — different transports,
  different lifetimes, different stores.

## Refinement — realtime egress trim (migration 0014)

The leader feeds (`leader_positions` / `leader_actions`), refreshed every cycle
by `trader-watch`, drove a Supabase realtime-message + egress blowout (Vercel
Fast Origin Transfer). Mitigations layered on WITHOUT changing the two-transport
decision: narrow the `supabase_realtime` publication to the columns the cockpit
actually renders, drop redundant per-poll re-fetches of static candle/regime
payloads, and the client hooks unsubscribe while a tab is hidden + fall back to
a 60s refetch. The browser is still anon/RLS-select-only; the change is purely
volume control on the same Postgres-realtime transport.
