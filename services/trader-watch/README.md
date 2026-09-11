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

1. Picks the **top-N rated leaders** (default 50; set `TRADER_WATCH_TOP_N` or
   `--top N` to change) from the vendored
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
pnpm trader-watch                   # loop forever (~30s, top 50)
pnpm trader-watch --interval 15 --top 30

# Or via the NAS scaffold (from services/trader-watch/):
./build.sh      # pnpm install in the repo (ensures tsx + deps)
./start.sh      # start the loop, PID-tracked, logs → ./logs/
./status.sh     # process liveness + last heartbeat + recent logs
./stop.sh       # SIGTERM (finishes the in-flight cycle, then exits)
./update.sh     # stop → git pull → build → start
./watchdog.sh   # cron-friendly: restart if down (+ optional Healthchecks ping)
```

## Deploy on the NAS

The NAS is an **Asustor AS6704T** (ADM — no systemd). Everything runs from the
`admin` user's crontab, which only calls the scaffold scripts:

```
@reboot sleep 30 && cd /volume1/home/admin/hyperliquid/services/trader-watch && /bin/sh start.sh >> logs/cron-start.log 2>&1
*/3 * * * * cd /volume1/home/admin/hyperliquid/services/trader-watch && /bin/sh watchdog.sh >> logs/watchdog.log 2>&1
```

(`research-trader-worker` has the same pair on a `*/5` watchdog; `scripts/nas-watch.sh` runs `*/5`;
`nas-rerank.sh` runs Sundays 04:00.) `systemd/trader-watch.service` is for Linux
hosts with systemd, not the NAS.

### Node.js 24 (the NAS runtime)

**Do not use App Central's `nodejs` app.** It owns `/usr/local/bin/node`, and an
App Central update on 2026-09-02 silently swapped it for **v16**. tsx needs
Node >= 18, so every NAS loop died on its next launch: trader-watch went silent
on 09-03, and the `nas-watch.sh` steps and research worker failed too.

The NAS runs an official Node 24 build installed in the home directory, out of
App Central's reach:

```sh
mkdir -p /volume1/home/admin/.local && cd /volume1/home/admin/.local
V=v24.21.0   # current 24.x LTS: https://nodejs.org/dist/index.json
curl -fsSLO https://nodejs.org/dist/$V/node-$V-linux-x64.tar.gz
curl -fsSL https://nodejs.org/dist/$V/SHASUMS256.txt | grep "node-$V-linux-x64.tar.gz" | sha256sum -c \
  && tar xzf node-$V-linux-x64.tar.gz && ln -sfn node-$V-linux-x64 node
/volume1/home/admin/.local/node/bin/node -v    # → v24.x
```

The `&&` chain matters: if the checksum fails, nothing is extracted and the live
`node` symlink is untouched.

**How the scripts find it:** every NAS-run script (`start`/`build`/`update.sh` in
`services/trader-watch` and `services/research-trader-worker`, `scripts/nas-watch.sh`,
`nas-rerank.sh`) sources `ops/node-env.sh`, which picks,
in order: `NODE_BIN` (env) → `/volume1/home/admin/.local/node/bin/node` → `node`
on PATH. It uses the first **Node >= 24** it finds and puts it first on PATH
(so `tsx`'s `#!/usr/bin/env node`, `pnpm`, and `npx` all use it). If none
qualifies, the script **refuses to run** with a clear error (in the service log,
or a Healthchecks `/fail` for `nas-watch.sh`), and `update.sh` checks *before*
stopping the running service. The crontab needs no changes.

The iamrossi relayer on the same NAS uses the same install (its own
`services/relayer-service/node-env.sh`).

**Interactive shell** (to run `pnpm`/`node` by hand on the NAS):

```sh
export PATH=/volume1/home/admin/.local/node/bin:$PATH
```

**pnpm**: not pinned — whichever `pnpm` is on PATH runs under Node 24 (its
`#!/usr/bin/env node` finds the pinned Node first). `update.sh` checks `pnpm -v`
before stopping the service. If pnpm goes missing, reinstall it with the Node 24
PATH exported (`npm i -g pnpm`) — that lands in the versioned Node folder, so
redo it after each Node upgrade.

**Upgrading Node**: repeat the install block with the new `V` (`ln -sfn`
repoints the symlink; the old folder stays as a rollback). Then restart each
daemon on the new binary — `./stop.sh && ./start.sh` in each service dir
(`update.sh` also works but pulls `main`). `nas-watch.sh`/`nas-rerank.sh` pick it
up on their next run. Check a daemon: `readlink /proc/$(cat <service>.pid)/exe`.

## Configuration

The service reads the **repo's** env (`.env.local` — run `pnpm env:pull`). It
needs the Supabase service-role keys the cockpit already uses:

- `HL_SUPABASE_URL` (or `SUPABASE_URL`)
- `HL_SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`)

Optional, for the watchdog dead-man's switch (set in `services/trader-watch/.env`):

- `TRADER_WATCH_TOP_N` — how many top-rated leaders to watch (default 50). Set in
  the repo `.env.local` (or pass `--top N`).
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
