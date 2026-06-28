# Armed Ladder — UI Validation Test Plan

Interactive: **you execute each step in the UI** at `hyperliquid-rouge.vercel.app` →
**Ladders** tab; tell me when done and I **validate** (proofshot + admin API + DB read +
analysis-log). Firing steps (Section E) **I drive locally in paper** — they never touch
production money.

**Environment under test (current):** production LIVE · `LADDER_LIVE_ENABLED=true` ·
`LADDER_AUTOFIRE_ENABLED=false` (autonomous firing OFF) · migration 0023 applied.

**How I validate each step:** ① you proofshot / I capture the UI · ② `GET /api/cockpit/ladder`
(status/mode) · ③ DB read (rungs.status, cloid, precondition_hash, ladder_fires, disarm_reason)
· ④ analysis_log line. I'll state PASS/FAIL with the evidence.

---

## Section 0 — Baseline
- **0.1** Open the **Ladders** tab. Expect the existing paper test ladder **"ETH breakout
  pyramid" — ARMED**. → *I validate: list renders, one armed paper row.*

## Section A — Authoring & live risk preview (no writes)
- **A1** Click **+ New Ladder**. Fill **Title**, leave mode **PAPER**, set rung #1: coin ETH,
  LONG, action `open`, **Trigger ▲ 2000**, Risk 50, Stop 4%, Lev 5. → *Expect the Risk
  Preview to show Worst-case loss ≈ −$170, Total notional ≈ $1.3k, ETH long liq @ max, Expires
  24h, and the green **Create & Arm (paper)** enabled (no warnings).*
- **A2 (stop on wrong side)** Change Stop to a value that puts the stop above entry — i.e. set a
  negative/▲ relationship (or set a SHORT with a stop below). → *Expect a ⚠ warning "stop … not
  on the loss side" and **Arm disabled**.*
- **A3 (leverage over max)** Set Lev to 60. → *Expect ⚠ "leverage … exceeds ETH max" + Arm disabled.*
- **A4 (no title / bad expiry)** Clear the Title; set Expires (h) to 0. → *Expect ⚠ "title required"
  and "Expiry must be in the future" + Arm disabled.*
- **A5 (loss-cap breach)** Restore a valid rung; set **Max loss ($)** to 50 (worst-case ~170 > 50).
  → *Expect ⚠ "Worst-case loss … exceeds the cap" + Arm disabled.*
- **A6 (pyramiding — add must shrink + stop must tighten)** Restore Max loss 300. **+ add rung**:
  rung #2 ETH LONG action `add`, Trigger ▲ 2100, **Risk larger than #1** (e.g. size grows) and a
  **looser** stop. → *Expect ⚠ "adds must DECREASE" and/or "stop … must only TIGHTEN" + Arm disabled.*
- **A7 (multi-coin preview)** Make #2 a valid decreasing add, **+ add rung** #3 on **BTC** SHORT
  `open`, Trigger ▼ 60000. → *Expect per-coin liq rows for ETH long and BTC short; worst-case is
  the no-netting sum.*
> *I validate A1–A7 by proofshot (you capture or I drive) — these are pure client previews, no DB writes.*

## Section B — Paper arm + disarm lifecycle
- **B1** Build a clean single-rung PAPER ladder (A1 config), title "Test paper A" → **Create & Arm
  (paper)**. → *Expect the modal to close and the row to appear **ARMED · PAPER**.*
  → *I validate: GET shows status=armed/mode=paper; DB shows the rung `pending` with a `cloid`
  (`<id>:<rungId>`) and a non-null `precondition_hash`.*
- **B2 (disarm)** Click **Disarm** on "Test paper A". → *Expect status → **disarmed**.* → *I validate:
  DB `status=disarmed`, `disarm_reason='operator-disarm'`.*
- **B3 (disarm the baseline)** Disarm "ETH breakout pyramid" too (cleanup). → *I validate disarmed.*

## Section C — Live arm (authorization gate)
- **C1** New Ladder, valid single rung, toggle mode to **LIVE**. → *Expect the primary button to read
  **Create draft →** (not Arm).* Click it. → *Expect the **`arm <id8>`** phrase + input to appear.*
  → *I validate: a DRAFT live row exists (GET).*
- **C2 (wrong phrase)** Type a wrong phrase. → *Expect **Arm LIVE** stays disabled.* Type the exact
  `arm <id8>`. → *Expect it enables; click → row shows **ARMED · LIVE**.* → *I validate: GET
  status=armed/mode=live; DB precondition_hash set.*
- **C3** **Disarm** the live ladder (cleanup). → *I validate disarmed.*
> Note: live **arming** authorizes; it moves **no money**. Firing stays off (Section E covers the seam in paper).

## Section D — DB-enforced safety (I run; no UI)
- **D1 (scout/live boundary §3.6)** I attempt to insert `author='scout', mode='live'` and
  `author='scout', status='armed'` rows → *expect Postgres CHECK to REJECT both.*
- **D2 (anon write RLS)** I attempt an anon-key insert into `ladders` → *expect REJECT (select-only RLS).*
- **D3 (one-shot fire ledger)** I insert two `ladder_fires` rows with the same `dedupe_key` → *expect
  the 2nd to violate the unique index.*

## Section E — Fire-rung seam (PAPER, I drive locally; autofire ON locally only)
*Local `next start` with `LADDER_AUTOFIRE_ENABLED=true`, same Supabase, paper mode — never production.*
- **E1 (fires + brackets)** Arm a paper `open` ladder → POST `/ladder/fire-rung {ladderId,rungId}`.
  → *Expect `{fired:true}`; DB rung→`fired`, `ladder_fires`→`filled`; a paper position opens; an
  analysis-log "FIRED …" line.*
- **E2 (idempotent double-fire)** POST the same rung again. → *Expect `{skipped:'already-fired'}`,
  no second fill (the `dedupe_key` claim).*
- **E3 (kill-switch)** Set `LADDER_AUTOFIRE_ENABLED=false`, POST again. → *Expect **403**, no fire.*
- **E4 (add-risk-not-covered §2)** Arm a paper ladder whose rung is an `add` on a flat/zero-profit
  position → fire. → *Expect `{skipped:'add-risk-not-covered'}`, rung→`skipped`, no fill.*
- **E5 (not-armed / expired / scout)** Fire a disarmed ladder, an expired one, and (via DB) a scout
  ladder. → *Expect skips: `not-armed`, `expired`(+auto-disarm), `not-operator`.*

## Section F — Autonomous watcher (NOT YET BUILT — next phase)
The NAS watcher (evaluate completed candles → POST met rungs) is **P1d-3, not yet built**, and the
full autonomous live loop also requires the **§4b testnet rehearsal** before
`LADDER_AUTOFIRE_ENABLED` is ever flipped on in production. Out of scope for this round.

---

### Pass criteria
All A warnings gate Arm; B/C lifecycle transitions persist correctly; D enforcement rejects at the
DB; E fires/skips exactly per the guard stack with idempotency + kill-switch honored. Any FAIL → I fix,
re-validate, and we re-run that step.
