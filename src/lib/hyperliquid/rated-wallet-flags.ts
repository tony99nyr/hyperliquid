/**
 * Zero-import LEAF: the canonical set of rated-wallet RISK flags (the ones the UI
 * colors red / treats as blow-up risk).
 *
 * This lives apart from rated-wallets-service.ts ON PURPOSE: that service reads
 * the filesystem (server-only), so importing RISK_FLAGS from it into a CLIENT
 * component (the trader-detail drawer / flag helper) would drag `node:fs` into the
 * client bundle and break the webpack build. Keeping the constant in a dependency-
 * free leaf lets both server and client import it safely. Do NOT add imports here.
 */

/** Risk flags the UI should color red. */
export const RISK_FLAGS = new Set([
  'DISQUALIFIED', 'NO_STOPS', 'DEEP_MARTINGALE', 'DEEP_DRAWDOWN', 'FAT_WORST_LOSS',
  'LIVE_UNDERWATER', 'RIDE_OR_LIQUIDATE', 'BLOW_UP_RISK', 'LIVE_DEEP_STACK',
  'EXTREME_WIN_RATE', 'THIN_ALT_TRADER', 'SUB_MINUTE_SCALPER', 'TRADES_OVERNIGHT_EDT',
]);
