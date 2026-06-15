/**
 * Asset configuration (vendored-compatible stub).
 *
 * The vendored regime-detection-config keys per-asset config off `TradingAsset`.
 * In iamrossi this lived in a much larger asset-config module (contract
 * addresses, decimals, etc.) — none of which the pure regime logic needs, so
 * this repo keeps only the `TradingAsset` union the vendored code imports.
 */
export type TradingAsset = 'eth' | 'btc';
