# Pre-registration — `leader-follow` scout lane (rated-whale conviction follow)

**Registered 2026-08-15.** This lane predates the pre-registration discipline (it traded
n=4 as an unregistered "control", including three ~20-minute churn round-trips on
2026-08-14 — the exact drift this doc exists to stop). Those **4 prior trades are
PRE-REGISTRATION history and count toward NOTHING**; the forward test starts now, under
the frozen rule below. Registered simultaneously with the guard-level lane ALLOWLIST
(`REGISTERED_LANES`) so no unregistered lane can quietly trade again.

## Hypothesis

**Rated-whale conviction flow is informative.** When a top-rated leader (the graded
`rated-wallets` set — profitable, full-history wallets) adds ≥ $1M notional to a majors
position, following WITH them has positive expectancy over a multi-day hold — they have
information/skill worth borrowing, and $1M+ adds are conviction, not churn. NOT proven:
the 08-14 whipsaw (the same leader $10M short → flat → long inside 36h) is the standing
counter-evidence. This lane exists to prove or KILL it honestly.

## The exact rule (frozen)

- **Universe:** BTC, ETH, SOL, HYPE.
- **Signal:** a RATED leader **OPEN / ADD / FLIP ≥ $1,000,000 notional** on a universe
  coin (the `leader_actions` feed / the daemon's leader trigger, `leaderMinNotionalUsd`).
- **Entry:** WITH the leader's direction, one position per coin, scout floor risk.
  **Cooldown: ONE entry per coin per 24h** — the anti-churn rule; a cluster of adds is
  ONE signal, and a follow that stopped/exited is not re-entered on the next add within
  the window (the 08-14 failure mode: three same-thesis round-trips in one night).
- **Stop (hard invalidation):** **3%** from entry.
- **Exit (mechanical):** the leader **EXITS or FLIPS** the coin (per the same feed) OR
  the hard stop OR a **72h time-stop** — whichever first. NO discretionary early exits:
  20-minute holds are not this thesis; the bet is multi-hour/day borrowed conviction.
- **Tags:** `lane: 'leader-follow'`, `setupType: 'whale-conviction'`, record the leader
  address + add size in the thesis.

## Pre-registered pass / fail bar

- **KILL** if net expectancy < 0 after **15** closed trades, OR net < 0 past **30 days**
  with ≥5 closed.
- **GRADUATE to consideration** only at **≥ 20** closed AND expectancy **≥ +0.2R** AND
  positive after the live-decay haircut. A conversation, never an auto-promotion.
- **CHURN DIAGNOSTIC:** median hold time. If it collapses toward minutes again, the rule
  is not being followed — that is a compliance failure to fix, not data.

## The honest limits

- **Compliance-on-the-model** (as all lanes): the leader-exit signal surfaces in the
  snapshot, but the close executes via `scout:trade --exit`.
- **The leader feed's latency** (trader-watch poll cadence) means entries/exits lag the
  whale by minutes — that lag IS part of what's being tested (we can never front-run).
- The 08-14 pre-registration trades showed both faces: −$1.97/−$0.84 (BTC whipsaw) and
  +$1.27 (HYPE) — excluded from the record either way.
