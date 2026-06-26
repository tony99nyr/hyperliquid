/**
 * PURE parser for an HL `vaultDetails` response → a durable `vault_snapshots`
 * row's worth of fields. Lane A (vault allocation) reads this NAV track instead
 * of trading directionally. No I/O — the service fetches the raw payload and
 * feeds it in. Defensive: HL returns numbers as strings and the portfolio shape
 * varies, so every extraction coerces and falls back to null rather than throwing.
 *
 * See docs/scout/SCOUT_ALPHA_ROADMAP.md (Lane A).
 */

/** A coercion local to this module (HL sends numbers as strings). */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

export interface VaultSnapshot {
  vaultAddress: string;
  name: string;
  leader: string | null;
  /** 'hlp' = the protocol vault (no leader-key risk); 'operator' = a user vault. */
  kind: 'hlp' | 'operator';
  /** Latest account value (NAV) in USD, or null when the history is unreadable. */
  navUsd: number | null;
  /** Annualized return as a fraction (0.12 = 12%), when HL reports it. */
  aprAnnual: number | null;
  /** Worst peak-to-trough drawdown over the observed window, 0..1, or null. */
  maxDrawdownPct: number | null;
  /** Days between the earliest observed NAV point and `now`, or null. */
  ageDays: number | null;
  /** Leader's stake as a fraction of the vault (skin-in-the-game), or null. */
  leaderFraction: number | null;
  fetchedAtMs: number;
}

type HistPoint = [number, number]; // [ms, value]

/** Coerce HL's `[[ms, "value"], …]` history into clean numeric points. */
function toHistory(raw: unknown): HistPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: HistPoint[] = [];
  for (const pt of raw) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const t = num(pt[0]);
    const v = num(pt[1]);
    if (t !== null && v !== null) out.push([t, v]);
  }
  return out;
}

/**
 * Pick the widest portfolio window (most account-value points — usually
 * "allTime") and return BOTH its account-value and PnL series. The portfolio is
 * `[[label, { accountValueHistory, pnlHistory, vlm }], …]`.
 */
function pickWindow(portfolio: unknown): { accountValue: HistPoint[]; pnl: HistPoint[] } {
  if (!Array.isArray(portfolio)) return { accountValue: [], pnl: [] };
  let best: { accountValue: HistPoint[]; pnl: HistPoint[] } = { accountValue: [], pnl: [] };
  for (const entry of portfolio) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const win = entry[1] as { accountValueHistory?: unknown; pnlHistory?: unknown } | null;
    const accountValue = toHistory(win?.accountValueHistory);
    if (accountValue.length > best.accountValue.length) {
      best = { accountValue, pnl: toHistory(win?.pnlHistory) };
    }
  }
  return best;
}

/** Largest peak-to-trough DROP over a series, in the series' own units (≥0, null < 2 pts). */
export function peakToTroughDrop(series: HistPoint[]): number | null {
  if (series.length < 2) return null;
  let peak = -Infinity;
  let drop = 0;
  for (const [, v] of series) {
    if (v > peak) peak = v;
    drop = Math.max(drop, peak - v);
  }
  return drop;
}

export interface VaultReturn {
  /** Flow-free return over [sinceMs, latest] as a fraction (0.01 = 1%), or null. */
  returnFrac: number | null;
  /** Latest total NAV (AUM), for context. */
  navUsd: number | null;
  /** Days actually spanned by the return window (≤ requested when history is short). */
  spanDays: number | null;
}

/**
 * A passive allocator's return on a vault over [sinceMs, latest]. PURE.
 *
 * The HONEST, flow-free metric: `(cumulativePnl_latest − cumulativePnl_atStart)
 * / AUM_atStart`. We compute it from the vault's OWN pnl + account-value history
 * (not HL's opaque `apr`, whose scaling is unverified, and not raw AUM change,
 * which is polluted by deposits/withdrawals). Approximation: AUM ≈ its start
 * value over the window (fine for a weeks-long paper hold). Null when history is
 * too thin or the starting AUM is non-positive.
 */
export function vaultReturnSince(raw: Record<string, unknown>, sinceMs: number): VaultReturn {
  const { accountValue, pnl } = pickWindow(raw.portfolio);
  const navUsd = accountValue.length > 0 ? accountValue[accountValue.length - 1][1] : null;
  if (pnl.length < 2 || accountValue.length < 1) return { returnFrac: null, navUsd, spanDays: null };

  // First pnl point at/after the lookback start (fall back to the earliest point).
  const startIdx = pnl.findIndex(([t]) => t >= sinceMs);
  const sIdx = startIdx >= 0 ? startIdx : 0;
  const startT = pnl[sIdx][0];
  const pnlStart = pnl[sIdx][1];
  const pnlNow = pnl[pnl.length - 1][1];
  // AUM at the start time (capital base the return is earned on).
  const aumStart = (accountValue.find(([t]) => t >= startT) ?? accountValue[0])[1];
  if (!(aumStart > 0)) return { returnFrac: null, navUsd, spanDays: null };

  return {
    returnFrac: (pnlNow - pnlStart) / aumStart,
    navUsd,
    spanDays: Math.max(0, (pnl[pnl.length - 1][0] - startT) / 86_400_000),
  };
}

/**
 * Parse a raw `vaultDetails` payload into a VaultSnapshot. PURE.
 * `kind` is supplied by the caller (HLP is a known constant address).
 */
export function parseVaultSnapshot(
  raw: Record<string, unknown>,
  opts: { now: number; kind: 'hlp' | 'operator'; fallbackAddress?: string },
): VaultSnapshot {
  const { accountValue, pnl } = pickWindow(raw.portfolio);
  const navUsd = accountValue.length > 0 ? accountValue[accountValue.length - 1][1] : null;
  const earliestMs = accountValue.length > 0 ? accountValue[0][0] : null;
  const ageDays = earliestMs !== null ? Math.max(0, (opts.now - earliestMs) / 86_400_000) : null;

  // Honest drawdown: the worst peak-to-trough of the CUMULATIVE PnL curve
  // (flow-free — `accountValueHistory` is polluted by deposits/withdrawals, which
  // can read as a huge fake "drawdown"), normalized by the peak vault NAV. An
  // approximation of a passive allocator's strategy drawdown; null when no PnL.
  const peakNav = accountValue.reduce((m, [, v]) => Math.max(m, v), 0);
  const pnlDrop = peakToTroughDrop(pnl);
  const maxDrawdownPct = pnlDrop !== null && peakNav > 0 ? pnlDrop / peakNav : null;

  const vaultAddress =
    (typeof raw.vaultAddress === 'string' && raw.vaultAddress) || opts.fallbackAddress || '';

  return {
    vaultAddress: vaultAddress.toLowerCase(),
    name: typeof raw.name === 'string' ? raw.name : 'unknown vault',
    leader: typeof raw.leader === 'string' ? raw.leader.toLowerCase() : null,
    kind: opts.kind,
    navUsd,
    aprAnnual: num(raw.apr),
    maxDrawdownPct,
    ageDays,
    leaderFraction: num(raw.leaderFraction),
    fetchedAtMs: opts.now,
  };
}

export interface VaultSnapshotInsertRow {
  vault_address: string;
  name: string;
  kind: 'hlp' | 'operator';
  nav_usd: number | null;
  apr_annual: number | null;
  max_drawdown_pct: number | null;
  age_days: number | null;
  leader_fraction: number | null;
  fetched_at: string;
}

/** Map a parsed snapshot to its `vault_snapshots` insert row. PURE. */
export function buildVaultSnapshotRow(s: VaultSnapshot): VaultSnapshotInsertRow {
  return {
    vault_address: s.vaultAddress,
    name: s.name,
    kind: s.kind,
    nav_usd: s.navUsd,
    apr_annual: s.aprAnnual,
    max_drawdown_pct: s.maxDrawdownPct,
    age_days: s.ageDays,
    leader_fraction: s.leaderFraction,
    fetched_at: new Date(s.fetchedAtMs).toISOString(),
  };
}
