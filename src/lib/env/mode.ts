/**
 * Trading mode flag — the ONE env switch that flips paper ↔ live.
 *
 * This is the only place in the codebase that reads TRADING_MODE. Everything
 * downstream of the fill source is mode-unaware (see ADR-0001). Flipping to
 * live = setting `TRADING_MODE=live` in the deploy env and nothing else.
 */
import type { TradingMode } from '@/types/fill';

export const DEFAULT_TRADING_MODE: TradingMode = 'paper';

/**
 * Resolve the active trading mode from the environment. Anything other than the
 * exact string 'live' resolves to 'paper' — fail SAFE (you can only get live by
 * explicitly asking for it).
 */
export function getTradingMode(): TradingMode {
  return process.env.TRADING_MODE === 'live' ? 'live' : DEFAULT_TRADING_MODE;
}

/** True only when the environment explicitly opts into live trading. */
export function isLiveMode(): boolean {
  return getTradingMode() === 'live';
}
