/**
 * Types barrel. Vendored strategy code imports from `@/types`; cockpit code
 * should import the specific module (fill / position / cockpit / trading-core).
 */
export type {
  CandleSource,
  PriceCandle,
  SignalAction,
  TradingSignal,
  Trade,
  Portfolio,
  PortfolioSnapshot,
} from './trading-core';

export type {
  TradingMode,
  TradeIntent,
  CanonicalFill,
} from './fill';

export type {
  Position,
  PositionSide,
} from './position';

export type {
  MarketBookLevel,
  MarketTrade,
  FeedStatus,
  LiveMarketState,
} from './market';
