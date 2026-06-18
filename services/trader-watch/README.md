# Trade-Watch Service (Phase A)

An **always-on, NON-AGENT** poller that runs on the NAS (alongside the relayer)
and keeps Supabase fresh so the cockpit + Claude skills **read Supabase instead of
hammering Hyperliquid**. This also structurally fixes the Vercel 429s — all HL
reads centralize on this one NAS IP, and the cockpit reads Supabase.

> **WATCH-ONLY.** This service never places a trade. It reads the public HL
> `/info` API and writes leader tables. The no-trade invariant is pinned by
> `tests/lib/trader-watch/no-trade-guarantee.test.ts` (a static import scan).

## What Phase A does

Each cycle (default every 30s) it:

1. Picks the **top-N rated leaders** (default 30) from the vendored
   `data/backups/wallet-rating/rated-wallets.json` (via `getTopTraders`).
2. Fetches each leader's `clearinghouseState` (open positions) from HL.
3. **Diffs** this cycle's positions against the previous cycle's →
   `open` / `add` / `reduce` / `close` / `flip` actions.
4. Writes:
   - **`leader_positions`** — reconciled to exactly each leader's live book
     (closed coins deleted, current ones upserted).
   - **`leader_actions`** — append-only log of the detected transitions.

   Supabase realtime pushes both to the cockpit (rail / trader-detail /
   Leader-vs-You / action feed — wired in Phase C).

**Restart-safe:** the previous-snapshot baseline is in-memory, so the first
observation of each leader establishes a *silent* baseline (positions written, no
actions) — a restart never spams the feed with `open` actions for already-open
positions. `leader_positions` is reconciled every cycle, so the rail is correct
immediately after a restart.

**Stale guard:** a fail-soft stale HL read is treated as a failure and skipped —
never diffed — so an HL hiccup can't emit phantom `close` actions.

> Outbound-only — it opens **no listening port**, so no cloudflare tunnel is
> needed (unlike the relayer).

## Running it

The service runs the repo's TypeScript directly via `tsx` (same model as
`pnpm watch`) — there is no separate compile step.

```sh
# From the repo root, for a quick local check:
pnpm trader-watch --once            # one cycle, then exit
pnpm trader-watch                   # loop forever (~30s, top 30)
pnpm trader-watch --interval 15 --top 50

# Or via the NAS scaffold (from services/trader-watch/):
./build.sh      # pnpm install in the repo (ensures tsx + deps)
./start.sh      # start the loop, PID-tracked, logs → ./logs/
./status.sh     # process liveness + last heartbeat + recent logs
./stop.sh       # SIGTERM (finishes the in-flight cycle, then exits)
./update.sh     # stop → git pull → build → start
./watchdog.sh   # cron-friendly: restart if down (+ optional Healthchecks ping)
```

## Deploy on the NAS

Two options:

1. **systemd** (recommended): edit `systemd/trader-watch.service` for your paths
   (`WorkingDirectory` = the repo root, `User`, `EnvironmentFile`), then:
   ```sh
   sudo cp systemd/trader-watch.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now trader-watch
   sudo journalctl -u trader-watch -f
   ```
   `Restart=always` keeps it up; no separate watchdog cron needed.

2. **start.sh + cron watchdog**: run `./start.sh` and add a cron entry calling
   `./watchdog.sh` every few minutes.

## Configuration

The service reads the **repo's** env (`.env.local` — run `pnpm env:pull`). It
needs the Supabase service-role keys the cockpit already uses:

- `HL_SUPABASE_URL` (or `SUPABASE_URL`)
- `HL_SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`)

Optional, for the watchdog dead-man's switch (set in `services/trader-watch/.env`):

- `HEALTHCHECKS_TRADER_WATCH_URL` — pinged on each healthy watchdog run; `/fail`
  on a restart.

Apply the migration once in the Supabase SQL editor:
`supabase/migrations/0004_trader_watch.sql` (creates `leader_positions` +
`leader_actions`, RLS anon-select-only, realtime).

## Roadmap

- **Phase A (this):** scaffold + top-30 leader watcher → leader tables. ✅
- **Phase B:** daily deep re-rank cron (`fetchAllFills` + rating engine →
  `rated_wallets` table, replacing `rated-wallets.json`).
- **Phase C:** cockpit reads Supabase (rail / detail / Leader-vs-You / action feed).
- **Phase D:** trail-the-leader (leader action → alert → propose-exit; the user's
  stop + Safe-Exit always govern).
