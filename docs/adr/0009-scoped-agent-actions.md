# ADR-0009: Scoped agent actions on the live account

Status: Accepted (2026-11-20, operator decision)

## Context

The signing key lives only in the production deployment. A local run resolves to
`paper` (ADR-0001), so the agent on the operator's machine cannot touch a live
position. On 2026-11-20 a ladder was about to expire with open profit, the
operator agreed to tighten the stop, and the agent could only write instructions
for the cockpit. The same gap blocks `advise-exit` for a live position.

Two wider options were rejected:

- **Give the agent the admin PIN.** The PIN can do everything the cockpit can,
  including opening a position.
- **Copy the agent key to the local machine.** Every local script becomes a live
  script, and a second copy of the signing key exists on disk.

## Decision

**Production exposes one endpoint, `POST /api/agent/action`, with its own bearer
token. The endpoint offers three actions, and all of them can only reduce risk.** The
operator still approves each action in the conversation. The agent then runs
`pnpm skill:agent-action ... --confirm yes`.

| Action | What it does | What it cannot do |
| --- | --- | --- |
| `tighten-stop` | Places a tighter reduce-only stop, confirms that it rests, then cancels the older stops. | Loosen a stop, remove a stop, or leave the position without a stop. |
| `reduce` | Closes a fraction (above 0, at most 1) with a reduce-only market order. | Open, add or flip. The caller sends a fraction, never a side or a size. |
| `take-profit` (added 2026-11-22) | Places one reduce-only take-profit for the whole position, when none rests, and confirms that it rests. | Open, add or flip. Replace or cancel a resting take-profit. Rest with a trigger at a loss: the trigger (as rounded by the venue) must be 0.2% or more beyond the entry price and on the profit side of the mark. |

The rules:

- **Kill switch.** `AGENT_ACTIONS_ENABLED` is OFF by default. When it is off, the
  endpoint refuses every request before it checks the token.
- **Dedicated token.** `AGENT_ACTION_TOKEN` opens this route only. A token under
  32 characters counts as not configured. The admin PIN does not open the route.
- **Tighter only.** A short's stop may only move lower and a long's only higher,
  measured against the tightest resting stop. The new stop must sit on the
  protective side of the mark, between 0.5% and 50% from it. With no resting
  stop the request adds protection, so it is allowed.
- **Place first, confirm, then cancel.** The code cancels an old stop only after
  it reads the new stop back from the open orders. A new stop that already
  triggered, or that cannot be read back, leaves the old stops in place. After
  the cancel the code reads the stops once more. The three calls are not atomic
  at the exchange, so if no stop rests and the position is still open (the new
  stop triggered in between and filled in part), the code places the stop again
  for the rest and confirms that it rests. The action reports done only when the
  new stop rests, or when it triggered and closed the whole position. Every
  other end state is reported as incomplete, with a Discord alert. An old stop
  that still rests is reported; the tighter stop governs.
- **No bracket moves.** A position-attached stop is one leg of a stop and
  take-profit pair. A standalone replacement would outlive the pair, so the
  endpoint refuses and the operator moves a bracket in the cockpit.
- **Venue truth.** Side and size come from the clearinghouse read, which must be
  fresh and must list positions. The ledger is not consulted for size.
- **Lane boundary.** Live mainnet deployment and live session only. The account
  read is mainnet-only, so any other network is a refusal.
- **Fail closed.** An unreadable account, mark or resting stop is a refusal.
- **One close at a time.** `reduce` takes the same lock as the Layer-1 auto-exit
  (ADR-0007) before it reads the position. On an unknown outcome the lock is
  held until it expires.
- **Minimum notional.** `reduce` refuses a close under $10, and a partial close
  that leaves a remainder under $10. The check uses the size after the venue
  floors it to the coin's lot.
- **Audit.** Every executed action and every failure writes the analysis log
  and pings Discord from `HL Agent Action`.
- **Rate limit.** Six requests per minute.

The pure rules are in `src/lib/agent-actions/agent-action-business-logic.ts`.
The execution site is `src/lib/agent-actions/agent-action-service.ts`.

## Consequences

- The agent can protect profit or cut a position when the operator is away from
  the cockpit, after a yes in the conversation.
- The worst misuse of a leaked token is an early exit: a stop set close to the
  mark (never closer than 0.5%), or a flattened position. The token cannot add
  risk. Turn the kill switch off and rotate the token if it leaks.
- **The server cannot verify the operator's yes.** The approval moves from a
  cockpit tap to a yes in the conversation, and the script sends nothing without
  `--confirm yes`. Both checks run on the agent's side. Any process that can read
  the local token can call the endpoint with no approval. "The human confirms
  every action" therefore depends on the agent's conduct for this lane, and the
  design accepts that only because neither action can add risk. Turn
  `AGENT_ACTIONS_ENABLED` off when the lane is not in use.
- `reduce` rides `executeIntent`, so ADR-0001 holds: the fill is a
  `CanonicalFill` and the ledger path is the same as for every other trade.
- A full close leaves the resting stops on the exchange, because this lane never
  removes a stop. A leftover stop is reduce-only, so it cannot open a position,
  but it can close a later position on the same coin early. The report names
  each leftover stop, and the operator cancels it in the cockpit.
- A ladder reduce rung does not take the exit lock. An agent reduce and a ladder
  reduce can size from the same position at the same moment and together close
  more than either intended. Both are reduce-only, so the result is a smaller
  position, never a new one.
- A refusal returns its reason to the caller. Only an executed action, a failed
  action and an unknown outcome write the analysis log and ping Discord.

## Setup (operator)

1. Create a token of 32 characters or more, for example `openssl rand -hex 32`.
2. In the Vercel dashboard, set `AGENT_ACTION_TOKEN` to the token and
   `AGENT_ACTIONS_ENABLED` to `true` for Production. Redeploy.
3. In the local `.env.local`, set `AGENT_ACTION_TOKEN` to the same token and
   `AGENT_ACTION_URL` to the production base URL.

Do not paste the token into a chat or a commit.

## Addendum 2026-11-22: the take-profit action

- The take-profit is a standalone order, like the cockpit take-profit. The exchange
  does not cancel it when the position closes, and this endpoint never cancels an
  order. A stop and a take-profit therefore outlive each other: when one closes the
  position, the operator cancels the other in the cockpit. A leftover take-profit
  can close a later position in the same coin at once. `reduce` (full close) and
  `tighten-stop` name a leftover take-profit in their report.
- A position-attached order (`positionTpsl`) would remove this risk. The endpoint
  does not use it yet: a lone position-attached take-profit beside a standalone
  stop has no testnet rehearsal.
- The take-profit fills at market when the trigger is touched, like the cockpit
  take-profit and every stop. In a fast reversal the fill can be worse than the
  trigger. The entry margin guards against a typing error, not against slippage.
- `take-profit` takes no lock. Two requests at the same moment can both place an
  order. The action reads the resting take-profits back and reports more than one
  as not done. The agent sends one request and reads the open orders before any retry.
- After the placement the action reads the position again. A position that closed,
  changed side or changed size is reported as not done, and the order stays for the
  operator to judge.

