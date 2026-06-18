# Vision: HL Cockpit as a Multi-User Copilot Service (DEFERRED — v2 north star)

> Status: **exploration captured for later.** We are finishing the **single-operator**
> cockpit first (Phase C/D + the paper trial), proving it on one real account, then
> productizing into this. Nothing here is being built yet. The trade-watch service
> (shared leader intelligence) carries straight over — it's the shared brain for all
> users.

## The idea
Turn the personal cockpit into a **generic copilot service** that friends can use from
any web browser. Each user logs into their own account and connects their own
Hyperliquid account, sees their own trades/health/P&L, and gets the same Claude-driven
analysis + leader intelligence — isolated from every other user.

## What it requires — three pieces

### 1. Accounts / auth (browser-agnostic)
- Replace the single admin-PIN with **real accounts**. Natural fit: **Supabase Auth**
  (we're already on Supabase) — email / OAuth / magic-link, any browser, and it yields
  an `auth.uid()` that row-level security keys off.
- **Invite-code-gated signup** so it stays friends-only, not open to the public.

### 2. Per-user data isolation (multi-tenancy)
- Every per-user table (sessions, positions, fills, pnl, analysis, hypotheses, …) gets a
  `user_id`. RLS flips from today's "anon reads everything" to **`user_id = auth.uid()`** —
  a friend only ever sees their own data.
- The **trade-watch leader tables stay SHARED** (`leader_positions` / `leader_actions` /
  `rated_wallets`) — public market intelligence everyone benefits from. The watcher is the
  shared brain; only the per-user trading state is partitioned.

### 3. Per-user Hyperliquid account — the crux + the risk
Two very different products hide here:

| | **Advice-only (RECOMMENDED)** | **Cockpit executes for users** |
|---|---|---|
| HL connection | **address only, read-only** | the user's **signing key** |
| Who trades | the user (on HL / their own wallet) | the cockpit |
| Key custody | **none** | client-side signing *or* server-held agent keys |
| Liability | low | **high** (custody, security, legal) |

- **Recommendation: advice-only.** Each friend connects their HL account by **address
  (read-only)**; the cockpit reads their positions and gives analysis / health / leader
  intel / Leader-vs-You; **they execute on HL themselves** (paper mode to practice). This
  matches the founding ethos — *"the human is the stop; never custody."*
- If in-app execution is ever wanted, it must be **client-side signing only** (the user's
  wallet signs in their browser; the server never holds keys). **Never server-custody
  friends' trade-capable keys** — a breach would let an attacker trade every account, and
  it turns a tool into a custodial trading service with real regulatory exposure.

## The biggest lift (bigger than auth): a server-side agent
Today **Claude drives via the operator's terminal skills.** Friends can't each open a
terminal. A multi-user service needs Claude **served server-side** — the **Claude Agent
SDK** web-native model — so every user gets analysis / health / advice in their browser,
on demand. This is the major re-architecture the vision implies (the terminal-skills model
was right for one operator; it doesn't scale to N users).

## Suggested phasing (when we pick this up)
1. **Auth + multi-tenancy** — Supabase Auth + invite codes; add `user_id` + per-user RLS to
   the per-user tables; keep leader tables shared.
2. **Per-user HL (read-only)** — connect by address; per-user position/pnl tracking; paper
   mode per user.
3. **Server-side agent** — Claude Agent SDK serving per-user analysis in the browser
   (replaces terminal skills for the service tier).
4. **(Only if ever) client-side execution** — user-signed orders; never server custody.

## Why defer
Finish + prove the single-operator cockpit on one real account first (Phase C/D + the
weeks-long paper trial). Then we productize something proven — and the trade-watch brain,
the design system, the approval/Safe-Exit/no-auto-fire model, and the seamless paper↔live
seam all carry over unchanged.
