/**
 * PURE flag descriptors for the trader-detail drawer's risk/health read — the
 * "is this trader safe to follow" panel (the 0x418aa6 $16M-martingale lesson).
 *
 * Each rated-wallet flag is mapped to a severity + a one-line plain-English
 * meaning so the drawer can render color-coded chips with a tooltip/caption.
 * No I/O, no React — fixture-tested. Unknown / ad-hoc threshold flags (e.g.
 * `worstLossVsMedianWin>80`, `liquidations>3`) fall back to a sensible default
 * rather than rendering raw.
 *
 * Severity → color is decided by the consumer (panel-styles ZONE_COLORS): danger
 * = blow-up risk, warn = caution, clean = a positive signal, info = neutral.
 */

// Import RISK_FLAGS from the zero-import LEAF, not rated-wallets-service (which
// reads the filesystem). Importing the service into this client-bundled helper
// would drag node:fs into the browser build and break webpack.
import { RISK_FLAGS } from '@/lib/hyperliquid/rated-wallet-flags';

export type FlagSeverity = 'danger' | 'warn' | 'clean' | 'info';

export interface FlagDescriptor {
  code: string;
  severity: FlagSeverity;
  /** A short label for the chip (Title Case, abbreviations preserved). */
  label: string;
  /** One-line plain-English meaning for the caption/tooltip. */
  meaning: string;
}

/** Curated descriptors for the known flag vocabulary (data/.../rated-wallets.json knownFlags). */
const KNOWN: Record<string, { severity: FlagSeverity; label: string; meaning: string }> = {
  // --- danger: blow-up / disqualifying risk ---
  DISQUALIFIED: { severity: 'danger', label: 'Disqualified', meaning: 'Fails the rating gate — not safe to follow.' },
  BLOW_UP_RISK: { severity: 'danger', label: 'Blow-up Risk', meaning: 'Risk profile suggests a catastrophic-loss tail.' },
  DEEP_MARTINGALE: { severity: 'danger', label: 'Deep Martingale', meaning: 'Averages down hard into losers — the classic account-killer.' },
  NO_STOPS: { severity: 'danger', label: 'No Stops', meaning: 'Trades without protective stops — rides losses to the edge.' },
  RIDE_OR_LIQUIDATE: { severity: 'danger', label: 'Ride-or-Liquidate', meaning: 'Holds adverse positions to liquidation rather than cutting.' },
  LIVE_UNDERWATER: { severity: 'danger', label: 'Live Underwater', meaning: 'Currently holding an open position deep in the red.' },
  DEEP_DRAWDOWN: { severity: 'danger', label: 'Deep Drawdown', meaning: 'Has suffered a severe peak-to-trough equity drawdown.' },
  FAT_WORST_LOSS: { severity: 'danger', label: 'Fat Worst-Loss', meaning: 'Worst single loss dwarfs the median win — fragile risk control.' },
  EXTREME_WIN_RATE: { severity: 'danger', label: 'Extreme Win-Rate', meaning: 'A suspiciously high win-rate — often hides one fat tail loss.' },

  // --- warn: caution / capped ---
  LIVE_DEEP_STACK: { severity: 'warn', label: 'Live Deep Stack', meaning: 'Holds a large open notional right now — concentration risk.' },
  THIN_ALT_TRADER: { severity: 'warn', label: 'Thin Alt Trader', meaning: 'Trades illiquid alts — fills + exits may not be replicable.' },
  SUB_MINUTE_SCALPER: { severity: 'warn', label: 'Sub-minute Scalper', meaning: 'Holds for under a minute — impossible to copy by hand.' },
  TRADES_OVERNIGHT_EDT: { severity: 'warn', label: 'Trades Overnight (EDT)', meaning: 'Most activity is outside your watch window — hard to monitor.' },
  VAULT_LED: { severity: 'warn', label: 'Vault-led', meaning: 'Flow is vault-driven — may not reflect a single trader’s edge.' },
  NET_NEGATIVE_AFTER_COPY_COST: { severity: 'warn', label: 'Net-Neg After Cost', meaning: 'Edge does not survive realistic copy slippage + fees.' },

  // --- info: measurement caveats (not inherently bad) ---
  PROVISIONAL_NO_FILLS: { severity: 'info', label: 'Provisional (No Fills)', meaning: 'Too few fills to grade with confidence — capped rating.' },
  NO_FILL_DATA: { severity: 'info', label: 'No Fill Data', meaning: 'No cached fills — metrics are incomplete.' },
  ANTICIPATION_UNMEASURED: { severity: 'info', label: 'Anticipation Unmeasured', meaning: 'Could not measure whether they lead or chase the move.' },
  REACTS_NOT_ANTICIPATES: { severity: 'warn', label: 'Reacts, Not Anticipates', meaning: 'Tends to chase moves rather than front-run them.' },

  // --- clean: positive signals ---
  CLEAN_BOOK: { severity: 'clean', label: 'Clean Book', meaning: 'No risk flags — disciplined, stop-respecting book.' },
  PERSISTENT_SET: { severity: 'clean', label: 'Persistent Set', meaning: 'Consistently appears across rating windows — durable.' },
};

/** Ad-hoc threshold flags use a `<metric><op><value>` form; pretty-print + caution. */
function descriptorForAdHoc(code: string): FlagDescriptor {
  // e.g. "worstLossVsMedianWin>80" → "worstLossVsMedianWin > 80"
  const pretty = code.replace(/([<>]=?)/, ' $1 ');
  const severity: FlagSeverity = RISK_FLAGS.has(code) ? 'danger' : 'warn';
  return {
    code,
    severity,
    label: pretty,
    meaning: `Threshold flag: ${pretty}. A caution raised by the rating pipeline.`,
  };
}

/** Describe a single flag code. Falls back gracefully for unknown / ad-hoc flags. PURE. */
export function describeFlag(code: string): FlagDescriptor {
  const known = KNOWN[code];
  if (known) return { code, ...known };
  // Threshold-style ad-hoc flags (contain a comparison operator).
  if (/[<>]=?/.test(code)) return descriptorForAdHoc(code);
  // Truly unknown: title-case the code, severity from the canonical RISK set.
  const label = code
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    code,
    severity: RISK_FLAGS.has(code) ? 'danger' : 'info',
    label,
    meaning: 'No description available for this flag.',
  };
}

/** Describe every flag, sorted danger → warn → info → clean (worst first). PURE. */
export function describeFlags(codes: string[]): FlagDescriptor[] {
  const order: Record<FlagSeverity, number> = { danger: 0, warn: 1, info: 2, clean: 3 };
  return codes
    .map(describeFlag)
    .sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * A one-line overall "safe to follow?" verdict from the flag set + composite.
 * PURE — drives the drawer's headline read.
 */
export function followVerdict(flags: string[], composite: number | null): {
  level: FlagSeverity;
  headline: string;
} {
  const descriptors = flags.map(describeFlag);
  const hasDanger = descriptors.some((d) => d.severity === 'danger');
  const hasWarn = descriptors.some((d) => d.severity === 'warn');
  if (hasDanger) {
    return { level: 'danger', headline: 'High risk — blow-up flags present. Do NOT copy blindly.' };
  }
  if (hasWarn) {
    return { level: 'warn', headline: 'Caution — replicable with care; mind the flagged risks.' };
  }
  if (composite !== null && composite >= 7) {
    return { level: 'clean', headline: 'Clean read — disciplined book, strong composite.' };
  }
  return { level: 'info', headline: 'No blow-up flags — verify the numbers before following.' };
}
