/** Return true when the window sample supports the strongest significance claim. */
export function supportsStrongSignificance(args: {
  windowCount: number;
  ciLow: number;
  pLessEqualZero: number;
  perTradeSignificant: boolean;
}): boolean {
  return args.windowCount >= 12 && args.ciLow > 0 && args.pLessEqualZero < 0.05 && args.perTradeSignificant;
}
