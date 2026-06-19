# Live Execution Runbook (Phase 3)

How the HL Cockpit places **real** orders on Hyperliquid, what you need to
provision, and the exact testnet → mainnet checklist for flipping it on.

> **Status:** the live execution *path* is built, tested, and **gated off**. The
> default `TRADING_MODE=paper` means nothing can fire. Going live is a deliberate,
> operator-only sequence (below) — there is no code change required to flip it.

---

## 1. Mental model: an HL account *is* an Ethereum wallet

Hyperliquid has no separate "login." Your HL account is just an **Ethereum
keypair** — the same kind MetaMask/Rabby manage. Your address *is* your account;
you fund it with USDC and control it by signing with that key.

The cockpit uses a **two-key model** (the safety design):

```
  Your Ethereum wallet (MASTER)            Agent / API wallet (SEPARATE key)
  ─────────────────────────────           ──────────────────────────────────
  • IS your HL account                     • approved BY the master, ONE time
  • can deposit / withdraw / transfer      • can ONLY place + cancel orders
  • you keep it (MetaMask / Rabby)         • CANNOT withdraw funds — ever (HL rule)
  • signs the one-time `approveAgent`      • the cockpit signs orders with THIS key
  • NEVER given to the cockpit             • lives server-side as HL_AGENT_PRIVATE_KEY
```

**Why:** if the cockpit's key ever leaked, an attacker could place trades on your
account but **could not move a single dollar out**. The master key (the only one
that can withdraw) never touches the server.

So: you need a normal **Ethereum wallet** as your master account, and you hand the
cockpit only a disposable, **trade-only agent key**.

---

## 2. What you need

| Thing | What it is | Where it lives |
|---|---|---|
| **Master Ethereum wallet** | Your HL account; deposits + withdrawals + agent approval | Your MetaMask/Rabby — never on the server |
| **USDC collateral** | HL perps margin in USDC | Deposited into HL (bridged from Arbitrum) |
| **Agent / API wallet key** | A second keypair, approved to trade-only | Vercel env `HL_AGENT_PRIVATE_KEY` (server-only) |

---

## 3. How a live trade flows

```
 You approve a trade in the cockpit  (same popup as paper — NO-AUTO-FIRE)
        │
        ▼
 Server builds the IOC order + signs it with the AGENT key (EIP-712)
        │
        ▼
 POST https://api.hyperliquid.xyz/exchange
        │
        ▼
 HL sees an APPROVED agent for your account → executes on YOUR account / USDC
        │
        ▼
 Fill comes back → recorded identically to paper (the seam; ADR-0001)
```

Your **master wallet is not involved at trade time** — only at setup (deposit +
the one-time agent approval) and whenever *you* withdraw.

---

## 4. Setup (when you're ready — not yet)

### 4.1 Create + fund the HL account
1. Open the Hyperliquid web app and **connect your Ethereum wallet** → that wallet
   is your HL account.
2. **Deposit USDC** (bridges in from Arbitrum). This is your perps collateral.

### 4.2 Create the agent / API wallet
3. In the HL app's **API** section, generate an **agent / API wallet**. HL gives
   you a fresh private key and you sign one **`approveAgent`** transaction with
   your **master** wallet (this is the only step that touches the master key).
   - Agents are **trade-only** (cannot withdraw) and **revocable** any time.
   - Agents **expire** (≈90 days default) — re-approve when needed.
   - *(This is deliberately a one-time HL-UI action, kept out of the cockpit's
     hot path.)*

### 4.3 Configure the cockpit (Vercel env)
4. Set the env vars:

   | Env var | Value | Notes |
   |---|---|---|
   | `HL_AGENT_PRIVATE_KEY` | the agent key (`0x…`, 32-byte hex) | **server-only**, never `NEXT_PUBLIC_` |
   | `HL_NETWORK` | `testnet` first, then `mainnet` | picks the signing source + endpoints |
   | `TRADING_MODE` | leave `paper` until rehearsed, then `live` | the single flip |

---

## 5. Testnet → mainnet checklist

**Rehearse on testnet first.** With `HL_NETWORK=testnet` the cockpit signs against
and submits to HL testnet, and resolves the asset index + mid from testnet too.

- [ ] Agent wallet approved on **testnet**; `HL_AGENT_PRIVATE_KEY` set.
- [ ] `HL_NETWORK=testnet`, `TRADING_MODE=live`.
- [ ] Place a tiny order from the cockpit → confirm it fills on HL testnet and the
      fill renders in Open Positions with correct px/size/side.
- [ ] Confirm a reduce-only **close** works (and isn't silently dropped).
- [ ] Confirm a rejected/oversize order surfaces a clear error (not a silent fail).

**Then mainnet, tiny:**
- [ ] Agent wallet approved on **mainnet**; key swapped in.
- [ ] `HL_NETWORK=mainnet`, `TRADING_MODE=live`.
- [ ] Start with the **smallest** notional; verify one open + one close end-to-end.
- [ ] Watch fees/slippage vs the modeled values (see caveats).

**Rollback (instant):** set `TRADING_MODE=paper` (stops all live fills), and/or
**revoke the agent** on HL (kills the key's power entirely).

---

## 6. Caveats / things to know before trusting it

- **Market-equivalent = aggressive IOC.** HL has no true market order; the cockpit
  crosses the book with an IOC limit at mark ± **5%** (`SLIPPAGE_BUFFER`). HL fills
  at the resting book (never worse than that limit), so the buffer only guarantees
  the cross and **caps** worst-case slippage. Tune it if 5% feels loose/tight.
- **Fee is modeled, not actual.** The order response doesn't carry the fee, so P&L
  uses HL's published **taker** schedule. Real fees can differ slightly; a future
  refinement can read `userFills` for the exact fee.
- **Nonce is per-process.** Fine for one-at-a-time orders (the cockpit's model). If
  it ever fires concurrent orders, they must be serialized (HL tracks nonces per
  signer).
- **`approveAgent` signature chain id.** Verify the exact value for your network in
  the HL UI when approving (mainnet vs testnet differ) — out of the cockpit's path,
  but get it right at approval time.
- **The paper trial (Phase 2) is the real gate.** Prove the strategy on paper
  before any of this.

---

## 7. Where it lives in the code

| Concern | File |
|---|---|
| The one mode switch (`paper`/`live`) | `src/lib/env/mode.ts`, `src/lib/trading/fill-source.ts` |
| Live fill mapping → CanonicalFill | `src/lib/trading/fill-source-live.ts` |
| Signing + submission (isolated I/O) | `src/lib/hyperliquid/hyperliquid-exchange-service.ts` |
| Order building / formatting / parsing (pure, auditable) | `src/lib/hyperliquid/hyperliquid-order-business-logic.ts` |
| Env (`HL_AGENT_PRIVATE_KEY`, `HL_NETWORK`) | `src/lib/env/env.ts` |
| Signing crypto (delegated, vetted) | `@nktkas/hyperliquid` `signL1Action` |

**Security invariants (don't regress):** the agent key is read server-side only
and never logged; `liveFill` is reachable only when `TRADING_MODE=live`; every
execution path is admin-authed + explicit-operator-approved (no auto-fire); the
agent wallet cannot withdraw.

---

## 8. Still pending before "production live"

- Shared (cross-instance) rate-limit store.
- Hands-off take-profit / bracket orders.
- Live notifications (Discord/email on fills + errors).
- Optional: exact fee from `userFills`.
