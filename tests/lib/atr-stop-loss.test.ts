import { describe, it, expect } from 'vitest';
import {
  calculateStopLossPrice,
  updateStopLoss,
  createOpenPosition,
  checkStopLosses,
  getFallbackATRPercentage,
  calculateTakeProfitPrices,
  checkTakeProfit,
  checkTakeProfits,
  createOpenPositionWithTakeProfit,
  type StopLossConfig,
  type TakeProfitConfig,
  type OpenPosition,
} from '@/lib/strategy/risk/atr-stop-loss';
import type { Trade, PriceCandle } from '@/types';
import { v4 as uuidv4 } from 'uuid';

describe('ATR Stop Loss', () => {
  function createBuyTrade(price: number, timestamp: number = Date.now()): Trade {
    return {
      id: uuidv4(),
      type: 'buy',
      timestamp,
      ethPrice: price,
      ethAmount: 0.1,
      usdcAmount: price * 0.1,
      signal: 0.5,
      confidence: 0.8,
      portfolioValue: 1000,
    };
  }

  // Helper function for creating test candles (may be used in future tests)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function createPriceCandle(
    open: number,
    high: number,
    low: number,
    close: number,
    timestamp: number = Date.now()
  ): PriceCandle {
    return {
      timestamp,
      open,
      high,
      low,
      close,
      volume: 1000,
    };
  }

  describe('calculateStopLossPrice', () => {
    it('should calculate stop loss below entry price', () => {
      const entryPrice = 1000;
      const atr = 50; // ATR value
      const config: StopLossConfig = {
        enabled: true,
        atrMultiplier: 2.0,
        trailing: false,
        useEMA: true,
        atrPeriod: 14,
      };

      const stopLoss = calculateStopLossPrice(entryPrice, atr, config);
      expect(stopLoss).toBe(900); // 1000 - (50 * 2) = 900
    });

    it('should return 0 if disabled', () => {
      const entryPrice = 1000;
      const atr = 50;
      const config: StopLossConfig = {
        enabled: false,
        atrMultiplier: 2.0,
        trailing: false,
        useEMA: true,
        atrPeriod: 14,
      };

      const stopLoss = calculateStopLossPrice(entryPrice, atr, config);
      expect(stopLoss).toBe(0);
    });

    it('should handle different ATR multipliers', () => {
      const entryPrice = 1000;
      const atr = 50;
      
      const stopLoss1 = calculateStopLossPrice(entryPrice, atr, {
        enabled: true,
        atrMultiplier: 1.5,
        trailing: false,
        useEMA: true,
        atrPeriod: 14,
      });
      expect(stopLoss1).toBe(925); // 1000 - (50 * 1.5) = 925

      const stopLoss2 = calculateStopLossPrice(entryPrice, atr, {
        enabled: true,
        atrMultiplier: 3.0,
        trailing: false,
        useEMA: true,
        atrPeriod: 14,
      });
      expect(stopLoss2).toBe(850); // 1000 - (50 * 3) = 850
    });
  });

  describe('updateStopLoss', () => {
    it('should trigger exit when price hits stop loss', () => {
      const buyTrade = createBuyTrade(1000);
      const position: OpenPosition = {
        buyTrade,
        entryPrice: 1000,
        stopLossPrice: 900,
        highestPrice: 1000,
        atrAtEntry: 50,
      };

      const result = updateStopLoss(position, 890, 50, {
        enabled: true,
        atrMultiplier: 2.0,
        trailing: false,
        useEMA: true,
        atrPeriod: 14,
      });

      expect(result.shouldExit).toBe(true);
      expect(result.exitReason).toBe('stop-loss');
      expect(result.stopLossPrice).toBe(900);
    });

    it('should not exit when price is above stop loss', () => {
      const buyTrade = createBuyTrade(1000);
      const position: OpenPosition = {
        buyTrade,
        entryPrice: 1000,
        stopLossPrice: 900,
        highestPrice: 1000,
        atrAtEntry: 50,
      };

      const result = updateStopLoss(position, 950, 50, {
        enabled: true,
        atrMultiplier: 2.0,
        trailing: false,
        useEMA: true,
        atrPeriod: 14,
      });

      expect(result.shouldExit).toBe(false);
      expect(result.stopLossPrice).toBe(900);
    });

    it('should trail stop loss upward when trailing enabled', () => {
      const buyTrade = createBuyTrade(1000);
      const position: OpenPosition = {
        buyTrade,
        entryPrice: 1000,
        stopLossPrice: 898.2, // Initial: 1000 - (50 * 2) = 900 * 0.998 = 898.2
        highestPrice: 1000,
        atrAtEntry: 50,
      };

      // Price moves up to 1100
      const result1 = updateStopLoss(position, 1100, 50, {
        enabled: true,
        atrMultiplier: 2.0,
        trailing: true,
        useEMA: true,
        atrPeriod: 14,
      });

      expect(result1.shouldExit).toBe(false);
      // 1100 - (50 * 2) = 1000, with buffer: 1000 * 0.998 = 998
      expect(result1.stopLossPrice).toBeCloseTo(998, 0);
      expect(position.highestPrice).toBe(1100);
      expect(position.stopLossPrice).toBeCloseTo(998, 0);

      // Price moves up further to 1200
      const result2 = updateStopLoss(position, 1200, 50, {
        enabled: true,
        atrMultiplier: 2.0,
        trailing: true,
        useEMA: true,
        atrPeriod: 14,
      });

      expect(result2.shouldExit).toBe(false);
      // 1200 - (50 * 2) = 1100, with buffer: 1100 * 0.998 = 1097.8
      expect(result2.stopLossPrice).toBeCloseTo(1097.8, 0);
      expect(position.highestPrice).toBe(1200);
      expect(position.stopLossPrice).toBeCloseTo(1097.8, 0);
    });

    it('should not move stop loss down when trailing', () => {
      const buyTrade = createBuyTrade(1000);
      const position: OpenPosition = {
        buyTrade,
        entryPrice: 1000,
        stopLossPrice: 1097.8, // Already trailed up (based on highestPrice 1200)
        highestPrice: 1200,
        atrAtEntry: 50,
      };

      // Price drops to 1150, but stop loss should not move down from 1097.8
      // Since 1150 > 1097.8, should not exit
      const result = updateStopLoss(position, 1150, 50, {
        enabled: true,
        atrMultiplier: 2.0,
        trailing: true,
        useEMA: true,
        atrPeriod: 14,
      });

      expect(result.shouldExit).toBe(false);
      expect(result.stopLossPrice).toBeCloseTo(1097.8, 0); // Should stay at 1097.8, not move down
      expect(position.stopLossPrice).toBeCloseTo(1097.8, 0);
    });

    it('should trigger trailing stop when price drops below trailed stop', () => {
      const buyTrade = createBuyTrade(1000);
      const position: OpenPosition = {
        buyTrade,
        entryPrice: 1000,
        stopLossPrice: 1097.8, // Trailed up (with slippage buffer)
        highestPrice: 1200,
        atrAtEntry: 50,
      };

      // Price drops below trailing stop
      const result = updateStopLoss(position, 1090, 50, {
        enabled: true,
        atrMultiplier: 2.0,
        trailing: true,
        useEMA: true,
        atrPeriod: 14,
      });

      expect(result.shouldExit).toBe(true);
      expect(result.exitReason).toBe('trailing-stop');
    });

    it('should use entry ATR as fallback when current ATR is null', () => {
      const buyTrade = createBuyTrade(1000);
      const position: OpenPosition = {
        buyTrade,
        entryPrice: 1000,
        stopLossPrice: 898.2, // Initial stop with buffer
        highestPrice: 1000,
        atrAtEntry: 50,
      };

      // Price moves up, but current ATR is null (low-vol period)
      // Should use entry ATR as fallback
      const result = updateStopLoss(position, 1100, null, {
        enabled: true,
        atrMultiplier: 2.0,
        trailing: true,
        useEMA: true,
        atrPeriod: 14,
      });

      expect(result.shouldExit).toBe(false);
      // Should trail: 1100 - (50 * 2) = 1000, with buffer: 1000 * 0.998 = 998
      expect(result.stopLossPrice).toBeCloseTo(998, 0);
      expect(position.highestPrice).toBe(1100);
    });
  });

  describe('createOpenPosition', () => {
    it('should create position with stop loss including slippage buffer', () => {
      const buyTrade = createBuyTrade(1000);
      const position = createOpenPosition(buyTrade, 1000, 50, {
        enabled: true,
        atrMultiplier: 2.0,
        trailing: true,
        useEMA: true,
        atrPeriod: 14,
      });

      expect(position).not.toBeNull();
      expect(position!.entryPrice).toBe(1000);
      // Stop loss: 1000 - (50 * 2) = 900, with 0.2% slippage buffer: 900 * 0.998 = 898.2
      expect(position!.stopLossPrice).toBeCloseTo(898.2, 1);
      expect(position!.highestPrice).toBe(1000);
      expect(position!.atrAtEntry).toBe(50);
    });

    it('should return null if disabled', () => {
      const buyTrade = createBuyTrade(1000);
      const position = createOpenPosition(buyTrade, 1000, 50, {
        enabled: false,
        atrMultiplier: 2.0,
        trailing: true,
        useEMA: true,
        atrPeriod: 14,
      });

      expect(position).toBeNull();
    });

    it('should use volatility-regime-aware fallback when ATR is null', () => {
      const buyTrade = createBuyTrade(1000);

      // Low volatility regime - 1.5% fallback
      const positionLow = createOpenPosition(buyTrade, 1000, null, {
        enabled: true,
        atrMultiplier: 2.0,
        trailing: true,
        useEMA: true,
        atrPeriod: 14,
      }, 'low');
      expect(positionLow).not.toBeNull();
      // Fallback ATR: 1000 * 0.015 = 15, Stop: 1000 - (15 * 2) = 970, with buffer: 970 * 0.998 = 968.06
      expect(positionLow!.stopLossPrice).toBeCloseTo(968.06, 1);

      // High volatility regime - 5% fallback
      const positionHigh = createOpenPosition(buyTrade, 1000, null, {
        enabled: true,
        atrMultiplier: 2.0,
        trailing: true,
        useEMA: true,
        atrPeriod: 14,
      }, 'high');
      expect(positionHigh).not.toBeNull();
      // Fallback ATR: 1000 * 0.05 = 50, Stop: 1000 - (50 * 2) = 900, with buffer: 900 * 0.998 = 898.2
      expect(positionHigh!.stopLossPrice).toBeCloseTo(898.2, 1);
    });
  });

  describe('getFallbackATRPercentage', () => {
    it('should return correct percentages for volatility regimes', () => {
      expect(getFallbackATRPercentage('low')).toBe(0.015);
      expect(getFallbackATRPercentage('normal')).toBe(0.03);
      expect(getFallbackATRPercentage('high')).toBe(0.05);
    });
  });

  describe('checkStopLosses', () => {
    it('should check multiple positions', () => {
      const buyTrade1 = createBuyTrade(1000);
      const buyTrade2 = createBuyTrade(2000);

      const positions: OpenPosition[] = [
        {
          buyTrade: buyTrade1,
          entryPrice: 1000,
          stopLossPrice: 900,
          highestPrice: 1000,
          atrAtEntry: 50,
        },
        {
          buyTrade: buyTrade2,
          entryPrice: 2000,
          stopLossPrice: 1900,
          highestPrice: 2000,
          atrAtEntry: 50,
        },
      ];

      // Price at 850 - first position should exit (850 < 900)
      // Second position: 850 < 1900, so should also exit
      const results = checkStopLosses(positions, 850, 50, {
        enabled: true,
        atrMultiplier: 2.0,
        trailing: false,
        useEMA: true,
        atrPeriod: 14,
      });

      expect(results.length).toBe(2);
      expect(results[0]!.result.shouldExit).toBe(true); // First position hit stop (850 < 900)
      expect(results[1]!.result.shouldExit).toBe(true); // Second position also hit stop (850 < 1900)
    });
  });

  // ============================================================================
  // Take-Profit Tests
  // ============================================================================

  describe('Take-Profit', () => {
    const defaultTakeProfitConfig: TakeProfitConfig = {
      enabled: true,
      tiers: [
        { atrMultiplier: 2.0, exitPct: 0.4 },
        { atrMultiplier: 4.0, exitPct: 0.5 },
      ],
      useATRFromEntry: true,
      regimeAwareTakeProfit: false,
    };

    describe('calculateTakeProfitPrices', () => {
      it('should calculate take-profit prices above entry price', () => {
        const entryPrice = 1000;
        const atr = 50;

        const prices = calculateTakeProfitPrices(entryPrice, atr, defaultTakeProfitConfig);

        expect(prices.length).toBe(2);
        expect(prices[0]).toBe(1100); // 1000 + (50 * 2) = 1100
        expect(prices[1]).toBe(1200); // 1000 + (50 * 4) = 1200
      });

      it('should return empty array if disabled', () => {
        const entryPrice = 1000;
        const atr = 50;
        const config: TakeProfitConfig = {
          ...defaultTakeProfitConfig,
          enabled: false,
        };

        const prices = calculateTakeProfitPrices(entryPrice, atr, config);

        expect(prices.length).toBe(0);
      });

      it('should apply regime-aware multiplier in bullish regime', () => {
        const entryPrice = 1000;
        const atr = 50;
        const config: TakeProfitConfig = {
          ...defaultTakeProfitConfig,
          regimeAwareTakeProfit: true,
        };

        // Bullish regime: 1.2x wider targets
        const prices = calculateTakeProfitPrices(entryPrice, atr, config, 'bullish');

        // Tier 1: 2.0 * 1.2 = 2.4 → 1000 + (50 * 2.4) = 1120
        expect(prices[0]).toBe(1120);
        // Tier 2: 4.0 * 1.2 = 4.8 → 1000 + (50 * 4.8) = 1240
        expect(prices[1]).toBe(1240);
      });

      it('should apply regime-aware multiplier in bearish regime', () => {
        const entryPrice = 1000;
        const atr = 50;
        const config: TakeProfitConfig = {
          ...defaultTakeProfitConfig,
          regimeAwareTakeProfit: true,
        };

        // Bearish regime: 0.8x tighter targets
        const prices = calculateTakeProfitPrices(entryPrice, atr, config, 'bearish');

        // Tier 1: 2.0 * 0.8 = 1.6 → 1000 + (50 * 1.6) = 1080
        expect(prices[0]).toBe(1080);
        // Tier 2: 4.0 * 0.8 = 3.2 → 1000 + (50 * 3.2) = 1160
        expect(prices[1]).toBe(1160);
      });
    });

    describe('checkTakeProfit', () => {
      it('should trigger take-profit when price reaches target', () => {
        const buyTrade = createBuyTrade(1000);
        const position: OpenPosition = {
          buyTrade,
          entryPrice: 1000,
          stopLossPrice: 900,
          highestPrice: 1000,
          atrAtEntry: 50,
          takeProfitPrices: [1100, 1200],
          completedTiers: 0,
          remainingPositionPct: 1.0,
        };

        // Price at 1110 (above first TP of 1100)
        const result = checkTakeProfit(position, 1110, defaultTakeProfitConfig);

        expect(result.shouldExit).toBe(true);
        expect(result.exitReason).toBe('take-profit');
        expect(result.tierTriggered).toBe(0);
        expect(result.exitPct).toBe(0.4); // 40% exit
        expect(result.remainingPositionPct).toBe(0.6); // 60% remaining
        expect(position.completedTiers).toBe(1);
        expect(position.remainingPositionPct).toBe(0.6);
      });

      it('should not trigger if price below all targets', () => {
        const buyTrade = createBuyTrade(1000);
        const position: OpenPosition = {
          buyTrade,
          entryPrice: 1000,
          stopLossPrice: 900,
          highestPrice: 1000,
          atrAtEntry: 50,
          takeProfitPrices: [1100, 1200],
          completedTiers: 0,
          remainingPositionPct: 1.0,
        };

        // Price at 1050 (below first TP of 1100)
        const result = checkTakeProfit(position, 1050, defaultTakeProfitConfig);

        expect(result.shouldExit).toBe(false);
        expect(result.exitPct).toBe(0);
        expect(result.remainingPositionPct).toBe(1.0);
        expect(position.completedTiers).toBe(0);
      });

      it('should trigger second tier after first is completed', () => {
        const buyTrade = createBuyTrade(1000);
        const position: OpenPosition = {
          buyTrade,
          entryPrice: 1000,
          stopLossPrice: 900,
          highestPrice: 1000,
          atrAtEntry: 50,
          takeProfitPrices: [1100, 1200],
          completedTiers: 1, // First tier already triggered
          remainingPositionPct: 0.6, // 60% remaining after first exit
        };

        // Price at 1210 (above second TP of 1200)
        const result = checkTakeProfit(position, 1210, defaultTakeProfitConfig);

        expect(result.shouldExit).toBe(true);
        expect(result.tierTriggered).toBe(1);
        expect(result.exitPct).toBe(0.5); // 50% of remaining
        // Remaining: 0.6 * (1 - 0.5) = 0.3
        expect(result.remainingPositionPct).toBe(0.3);
        expect(position.completedTiers).toBe(2);
      });

      it('should not trigger when all tiers completed', () => {
        const buyTrade = createBuyTrade(1000);
        const position: OpenPosition = {
          buyTrade,
          entryPrice: 1000,
          stopLossPrice: 900,
          highestPrice: 1000,
          atrAtEntry: 50,
          takeProfitPrices: [1100, 1200],
          completedTiers: 2, // All tiers completed
          remainingPositionPct: 0.3,
        };

        // Price at 1300 (above all targets, but all completed)
        const result = checkTakeProfit(position, 1300, defaultTakeProfitConfig);

        expect(result.shouldExit).toBe(false);
        expect(result.remainingPositionPct).toBe(0.3);
      });

      it('should initialize take-profit prices if not set', () => {
        const buyTrade = createBuyTrade(1000);
        const position: OpenPosition = {
          buyTrade,
          entryPrice: 1000,
          stopLossPrice: 900,
          highestPrice: 1000,
          atrAtEntry: 50,
          // No takeProfitPrices set
        };

        // Price at 1110 (above first calculated TP)
        const result = checkTakeProfit(position, 1110, defaultTakeProfitConfig);

        // Should have initialized and triggered
        expect(result.shouldExit).toBe(true);
        expect(position.takeProfitPrices).toBeDefined();
        expect(position.takeProfitPrices![0]).toBe(1100);
        expect(position.takeProfitPrices![1]).toBe(1200);
      });

      it('should return no-op result when disabled', () => {
        const buyTrade = createBuyTrade(1000);
        const position: OpenPosition = {
          buyTrade,
          entryPrice: 1000,
          stopLossPrice: 900,
          highestPrice: 1000,
          atrAtEntry: 50,
        };

        const disabledConfig: TakeProfitConfig = {
          ...defaultTakeProfitConfig,
          enabled: false,
        };

        const result = checkTakeProfit(position, 1500, disabledConfig);

        expect(result.shouldExit).toBe(false);
        expect(result.takeProfitPrice).toBe(0);
      });
    });

    describe('checkTakeProfits', () => {
      it('should check multiple positions', () => {
        const buyTrade1 = createBuyTrade(1000);
        const buyTrade2 = createBuyTrade(2000);

        const positions: OpenPosition[] = [
          {
            buyTrade: buyTrade1,
            entryPrice: 1000,
            stopLossPrice: 900,
            highestPrice: 1000,
            atrAtEntry: 50,
            takeProfitPrices: [1100, 1200],
            completedTiers: 0,
            remainingPositionPct: 1.0,
          },
          {
            buyTrade: buyTrade2,
            entryPrice: 2000,
            stopLossPrice: 1900,
            highestPrice: 2000,
            atrAtEntry: 100,
            takeProfitPrices: [2200, 2400],
            completedTiers: 0,
            remainingPositionPct: 1.0,
          },
        ];

        // Price at 1150 - first position hits TP (1150 > 1100)
        // Second position at same price doesn't hit TP (1150 < 2200)
        const results = checkTakeProfits(positions, 1150, defaultTakeProfitConfig);

        expect(results.length).toBe(2);
        expect(results[0]!.result.shouldExit).toBe(true);
        expect(results[1]!.result.shouldExit).toBe(false);
      });
    });

    describe('createOpenPositionWithTakeProfit', () => {
      const defaultStopLossConfig: StopLossConfig = {
        enabled: true,
        atrMultiplier: 2.0,
        trailing: true,
        useEMA: true,
        atrPeriod: 14,
      };

      it('should create position with both stop-loss and take-profit', () => {
        const buyTrade = createBuyTrade(1000);
        const position = createOpenPositionWithTakeProfit(
          buyTrade,
          1000,
          50,
          defaultStopLossConfig,
          defaultTakeProfitConfig
        );

        expect(position).not.toBeNull();
        expect(position!.entryPrice).toBe(1000);
        // Stop loss with buffer: (1000 - 100) * 0.998 = 898.2
        expect(position!.stopLossPrice).toBeCloseTo(898.2, 1);
        expect(position!.takeProfitPrices).toBeDefined();
        expect(position!.takeProfitPrices!.length).toBe(2);
        expect(position!.takeProfitPrices![0]).toBe(1100); // 1000 + 50*2
        expect(position!.takeProfitPrices![1]).toBe(1200); // 1000 + 50*4
        expect(position!.completedTiers).toBe(0);
        expect(position!.remainingPositionPct).toBe(1.0);
      });

      it('should return null if stop-loss disabled', () => {
        const buyTrade = createBuyTrade(1000);
        const disabledStopLoss: StopLossConfig = {
          ...defaultStopLossConfig,
          enabled: false,
        };

        const position = createOpenPositionWithTakeProfit(
          buyTrade,
          1000,
          50,
          disabledStopLoss,
          defaultTakeProfitConfig
        );

        expect(position).toBeNull();
      });

      it('should create position without take-profit if TP disabled', () => {
        const buyTrade = createBuyTrade(1000);
        const disabledTP: TakeProfitConfig = {
          ...defaultTakeProfitConfig,
          enabled: false,
        };

        const position = createOpenPositionWithTakeProfit(
          buyTrade,
          1000,
          50,
          defaultStopLossConfig,
          disabledTP
        );

        expect(position).not.toBeNull();
        expect(position!.stopLossPrice).toBeCloseTo(898.2, 1);
        expect(position!.takeProfitPrices).toBeUndefined();
      });

      it('should apply regime-aware adjustments to take-profit', () => {
        const buyTrade = createBuyTrade(1000);
        const regimeAwareTP: TakeProfitConfig = {
          ...defaultTakeProfitConfig,
          regimeAwareTakeProfit: true,
        };

        // Bullish regime: wider TP targets
        const position = createOpenPositionWithTakeProfit(
          buyTrade,
          1000,
          50,
          defaultStopLossConfig,
          regimeAwareTP,
          'normal',
          'bullish'
        );

        expect(position).not.toBeNull();
        // Bullish: 1.2x multiplier
        // Tier 1: 1000 + 50 * 2 * 1.2 = 1120
        expect(position!.takeProfitPrices![0]).toBe(1120);
        // Tier 2: 1000 + 50 * 4 * 1.2 = 1240
        expect(position!.takeProfitPrices![1]).toBe(1240);
      });
    });
  });
});

