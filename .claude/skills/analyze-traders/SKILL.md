---
name: analyze-traders
description: >-
  Discover and grade Hyperliquid traders to potentially follow this session.
  Use when the user says "find traders", "who should I follow", "grade these
  wallets", "analyze leaders", "rank HL traders", or pastes one or more HL
  addresses to evaluate. ADVISORY ONLY — produces a ranked, gated shortlist for
  the user to pick from; it never opens a position. Enforces the
  INSUFFICIENT_HISTORY data-completeness gate (a thin or page-capped wallet can
  never be graded a clean A).
---

# analyze-traders (advisory)

Single purpose: grade candidate Hyperliquid wallets on their FULL fill history
and present a ranked shortlist. The user picks who to follow. **This skill never
trades.**

## The hard rule — INSUFFICIENT_HISTORY gate

A wallet whose fetched fill history is thin (< 50 fills) or page-capped
(~2000 fills, i.e. truncated) is flagged `INSUFFICIENT_HISTORY` and **cannot be
graded a clean A** — it is capped at B. This is the 0x418aa6 lesson: a wallet
looked like a clean A on thin data, then turned out to be a $16M live martingale
once the full history loaded. Never present a thin-data wallet as an A. The gate
is enforced in `analyze-traders-business-logic.ts` and pinned by tests.

## Protocol

1. Confirm there is an active session id (from `open-session` / the cockpit). Ask
   the user for it if unknown.
2. Determine the candidate set:
   - If the user gave specific addresses, use `--addresses 0x..,0x..`.
   - Otherwise grade the top rated wallets with `--top N` (default 10).
3. Run: `pnpm skill:analyze-traders --session <id> [--addresses ...] [--top N]`.
4. The script fetches live HL `clearinghouseState` + a deep `userFillsByTime`
   window per wallet (read-only), runs the PURE grader (completeness gate +
   copy-monitor alerts), ranks, and writes an `analysis_log` row.
5. Relay the ranked candidates to the user. For each, surface: grade,
   completeness (calling out any `INSUFFICIENT_HISTORY` explicitly), and the
   danger/warn alerts (martingale, no-stops, deep stack, …).
6. Ask the user to pick a candidate (or none). Do not pick for them.
7. Next step: run `analyze-market-timeframes` for the coin the chosen leader is
   in, before any `open-position`.

## Guardrails

- Advisory only — no `executeIntent`, no orders.
- Never describe an `INSUFFICIENT_HISTORY` wallet as a clean A.
- Surface every `danger` alert; do not bury copy-risk.
