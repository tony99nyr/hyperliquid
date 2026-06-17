# HL Cockpit — design-handoff parity

Visual verification of the design-alignment recreation. Each `design-*.png`
below was captured from the REAL app (`pnpm verify:design`) — built, served,
authenticated, and seeded with temporary cockpit state through the real write
path (`executeIntent` / `createPendingAction`), then cleaned up (every seeded
session deleted, ON DELETE CASCADE; the harness asserts none remain). Compare
against the prototype references in `/tmp/hl-design-handoff/*.png`.

| Surface | Recreation | Prototype ref | Parity |
|---|---|---|---|
| Cockpit (with position) | `design-01-cockpit.png` | `01-cockpit.png` | Strong — top bar (brand + Cockpit/Performance nav + Equity/PAPER pill + feed dot), Top Traders rail (rank/addr/RISK/score), chart card (BEAR bias chip + 1m–1d tabs + MA20/MA50 legend), Open-Positions focal panel, Market Regime panel + Order Book, Analysis tabs, bottom status bar. |
| Approval modal | `design-03-approval.png` | `03-approval.png` | Strong — CONFIRM ORDER / "you approve · you execute" / PAPER, LONG/SHORT toggle, size + ≈notional, leverage slider + Match-leader/½-leader, full summary (entry/notional/margin/liq +%away/stop/fee), following-leader, risk note, weighted Approve. |
| Exit modal | `design-20-exit.png` | `20-exit.png` | Strong — CLOSE ETH-PERP, close-amount slider (5–100%) + 25/50/75/100 presets, summary (closing/exit/entry/est. realized PnL/fee/resulting equity), red Close Short. Computed from real seeded data (realized +$0.53). |
| Trader drawer | `design-21-trader.png` | `21-trader.png` | Strong — right slide-over: address + score header, stats, LIVE POSITIONS, Recent Fills, Mirror/Watch footer. |
| Performance | `design-22-performance.png` | `22-performance.png` | Strong — 8 KPI cards, Account Equity 30-day area chart, Trade Ledger (Time/Market/Side/Entry/Exit/Lev/Realized PnL/Status with OPEN/WIN/LOSS chips). All derived from real fills. |
| Mobile Cockpit | `design-11-mobile-cockpit.png` | `11-mobile-cockpit.png` | Good — sticky header + nav + equity, PAPER banner, ETH/BTC coin tabs, chart + Trade Health + Order Book stacked, bottom status bar. Deviation: nav lives in the top bar; no dedicated bottom tab bar (Cockpit/Traders/Performance). |

## Preserved hardened wiring (verified live)
- No-auto-fire: only an approved ApprovalPopup or a Safe-Exit click executes.
- Paper↔live seam (`fill-source.ts`), leverage-through-approval (server-validated),
  liquidation-inside-stop gate, LIVE typed-phrase gate, ApprovalPopup a11y.
- Every Reduce / Close / Safe-Exit-ALL rides the reduce-only `/api/cockpit/safe-exit`
  route (partial closes via an added, clamped `fraction`) — can never grow exposure.
