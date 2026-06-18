---
name: review-previews
description: >-
  List the operator's open Hyperliquid position previews and write Claude's
  advisory review (endorse / caution / avoid + a note) onto one. Use when the
  operator has created a proposed OPEN position in the cockpit (a "preview") and
  wants Claude's read before they approve it, or says "review my previews",
  "what do you think of this preview", "should I take the setup I queued",
  "look at the preview I created". ADVISORY ONLY — writing a review NEVER
  executes the trade; only the operator's UI Approve fires it. It never
  auto-fires.
---

# review-previews (ADVISORY — never executes)

Single purpose: surface the operator's open previews and annotate one with
Claude's verdict so the operator can decide. **Writing a review NEVER places an
order. Only the operator's UI Approve fires the trade (NO-AUTO-FIRE).**

## The hard principle

The operator authors a proposed OPEN position in the cockpit as a `preview`
(status=`preview`, origin=`operator`). This skill reads those previews and writes
a `review` annotation (`endorse` / `caution` / `avoid` + a note). The review is
PURELY advisory — it records Claude's read alongside the preview. It has no
execute path: the operator's UI Approve button is the only thing that can fire
the queued trade.

## When to use

The operator created (or already has) one or more open previews and wants
Claude's read before approving. Default to listing first, then review a specific
one by id.

## Two modes

1. **LIST (default — no `--id`)**: print every open operator preview with its id,
   coin/side/size, estimated entry, stop, leverage, the followed leader (if any),
   the rationale, and whether it already has a review.

   ```
   pnpm skill:review-previews
   ```

2. **REVIEW (`--id <uuid>`)**: write a verdict + note onto one preview. The
   verdict must be `endorse`, `caution`, or `avoid`, and the note must be
   non-empty.

   ```
   pnpm skill:review-previews --id <uuid> --verdict caution --note "Entry chases a vertical move; stop is wide for this size."
   ```

   On success the review is attached. If the id doesn't match an open operator
   preview (not found, or already decided/executed), the script prints a clear
   failure and writes nothing.

## Protocol

1. Run LIST to see the open previews and their ids.
2. Evaluate the preview the operator asked about (or each open one) — entry,
   stop, sizing/leverage, leader context, and the stated rationale.
3. Relay your read to the operator, then write it with REVIEW
   (`--id … --verdict … --note "…"`).
4. Tell the operator the review is in the cockpit and that THEY approve to fire it.

## Guardrails

- ADVISORY ONLY: this skill has NO execute path. A review never opens, modifies,
  or fires a position — the operator's UI Approve does (NO-AUTO-FIRE).
- `--verdict` must be exactly one of `endorse` | `caution` | `avoid`; the note
  must be non-empty.
- A failed REVIEW (id not found / already decided) writes nothing — re-list and
  retry against a current open preview.
