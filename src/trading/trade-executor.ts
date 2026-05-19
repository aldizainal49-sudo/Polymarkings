import { Market, TradeExecution, TradeSignal } from '../types';
import { config } from '../config';
import { logger } from '../config/logger';
import { KellyEngine } from '../kelly/kelly-engine';
import { PolymarketClient } from './polymarket-client';

/**
 * TRADE EXECUTOR
 * 
 * Executes trades on Polymarket based on signals:
 * - Uses Kelly Criterion for position sizing
 * - Places orders via Polymarket CLOB API
 * - Tracks open positions and resolves them
 * - Risk management: max position, correlation checks
 * - Auto-resolves when 5m market expires
 */
export class TradeExecutor {
  private client: PolymarketClient;
  private kelly: KellyEngine;
  private openTrades: Map<string, TradeExecution> = new Map();
  private tradeHistory: TradeExecution[] = [];
  private maxOpenPositions: number = 5;
  private cooldownMs: number = 30000; // 30s between trades
  private lastTradeTime: number = 0;

  constructor(client: PolymarketClient, kelly: KellyEngine) {
    this.client = client;
    this.kelly = kelly;
  }

  /**
   * Execute a trade based on signal
   */
  async executeTrade(signal: TradeSignal, market: Market): Promise<TradeExecution | null> {
    // Pre-trade checks
    if (!this.canExecute(signal)) return null;

    // Calculate position size with Kelly
    const betSize = this.kelly.calculateBetSize(signal);
    if (betSize <= 0) {
      logger.debug('Kelly suggests $0 bet, skipping');
      return null;
    }

    // Ensure we don't exceed balance
    const balance = this.kelly.getBankroll();
    const actualSize = Math.min(betSize, balance * config.maxBetFraction);

    if (actualSize < 0.50) {
      logger.debug(`Bet size too small: $${actualSize.toFixed(2)}`);
      return null;
    }

    logger.info(`\n🎯 EXECUTING TRADE:`);
    logger.info(`   Asset: ${signal.asset} | Direction: ${signal.direction}`);
    logger.info(`   Confidence: ${(signal.confidence * 100).toFixed(1)}% | Edge: ${(signal.edge * 100).toFixed(1)}%`);
    logger.info(`   Size: $${actualSize.toFixed(2)} | Kelly: ${(betSize / balance * 100).toFixed(1)}% of bankroll`);
    logger.info(`   Sources: ${signal.sources.map(s => s.type).join(', ')}`);

    // Place order - always BUY the token for our chosen direction
    const tokenId = market.tokenId;

    const orderResult = await this.client.placeOrder({
      tokenId,
      side: 'BUY',
      size: actualSize,
      orderType: 'FOK',
    });

    if (!orderResult || !orderResult.filled) {
      logger.warn(`Order not filled for ${signal.asset} ${signal.direction}`);
      return null;
    }

    // Create trade record
    const trade: TradeExecution = {
      id: this.generateTradeId(),
      market,
      direction: signal.direction,
      size: actualSize,
      entryPrice: orderResult.avgPrice || market.currentPrice,
      kellyFraction: betSize / balance,
      timestamp: Date.now(),
      resolved: false,
    };

    this.openTrades.set(trade.id, trade);
    this.lastTradeTime = Date.now();

    logger.info(`   ✅ FILLED @ ${trade.entryPrice.toFixed(4)} | Trade ID: ${trade.id.slice(0, 8)}`);
    logger.info(`   Open positions: ${this.openTrades.size}/${this.maxOpenPositions}\n`);

    return trade;
  }

  /**
   * Resolve a trade (market expired or manual close)
   */
  async resolveTrade(tradeId: string, won: boolean, exitPrice?: number): Promise<void> {
    const trade = this.openTrades.get(tradeId);
    if (!trade) {
      logger.warn(`Trade ${tradeId} not found in open positions`);
      return;
    }

    trade.resolved = true;
    trade.won = won;
    trade.exitPrice = exitPrice || (won ? 1.0 : 0.0);

    // Calculate profit/loss
    if (won) {
      trade.profit = (trade.exitPrice - trade.entryPrice) * trade.size / trade.entryPrice;
    } else {
      trade.profit = -trade.size; // Binary market: lose entire stake
    }

    // Update Kelly state
    this.kelly.recordTradeResult(trade);

    // Move to history
    this.openTrades.delete(tradeId);
    this.tradeHistory.push(trade);

    const emoji = won ? '🟢' : '🔴';
    logger.info(`${emoji} Trade resolved: ${trade.market.asset} ${trade.direction} | ${won ? 'WIN' : 'LOSS'} | P/L: $${(trade.profit || 0).toFixed(2)} | Bankroll: $${this.kelly.getBankroll().toFixed(2)}`);
  }

  /**
   * Check and resolve expired trades (5m markets)
   */
  async checkExpiredTrades(): Promise<void> {
    const now = Date.now();
    const expiredTrades: string[] = [];

    for (const [id, trade] of this.openTrades) {
      // 5 minute markets expire 5 min after start
      if (now >= trade.market.endTime) {
        expiredTrades.push(id);
      }
    }

    for (const tradeId of expiredTrades) {
      const trade = this.openTrades.get(tradeId)!;

      try {
        // Check market resolution
        const trades = await this.client.getRecentTrades(trade.market.conditionId, 5);
        const lastTrade = trades[0];

        // Determine if we won based on market resolution
        let won = false;
        if (lastTrade) {
          const resolvedPrice = parseFloat(lastTrade.price || '0.5');
          // If price went to 0.9+ (for our direction), we likely won
          won = resolvedPrice > 0.8;
        }

        await this.resolveTrade(tradeId, won);
      } catch (error: any) {
        logger.error(`Error resolving expired trade ${tradeId}: ${error.message}`);
        // Default to loss if we can't determine
        await this.resolveTrade(tradeId, false);
      }
    }
  }

  /**
   * Pre-trade validation checks
   */
  private canExecute(signal: TradeSignal): boolean {
    // Check Kelly allows trading
    if (!this.kelly.canTrade()) {
      logger.debug('Kelly says no trade (bankroll/drawdown limit)');
      return false;
    }

    // Check max open positions
    if (this.openTrades.size >= this.maxOpenPositions) {
      logger.debug(`Max open positions reached: ${this.openTrades.size}`);
      return false;
    }

    // Cooldown between trades
    if (Date.now() - this.lastTradeTime < this.cooldownMs) {
      logger.debug('Trade cooldown active');
      return false;
    }

    // Check for duplicate position (same asset + direction)
    for (const [, trade] of this.openTrades) {
      if (trade.market.asset === signal.asset && trade.direction === signal.direction) {
        logger.debug(`Already have open position: ${signal.asset} ${signal.direction}`);
        return false;
      }
    }

    // Minimum confidence
    if (signal.confidence < config.minConfidence) {
      logger.debug(`Confidence too low: ${signal.confidence}`);
      return false;
    }

    // Minimum edge
    if (signal.edge < config.minEdge) {
      logger.debug(`Edge too low: ${signal.edge}`);
      return false;
    }

    return true;
  }

  /**
   * Get all open trades
   */
  getOpenTrades(): TradeExecution[] {
    return Array.from(this.openTrades.values());
  }

  /**
   * Get trade history
   */
  getTradeHistory(): TradeExecution[] {
    return [...this.tradeHistory];
  }

  /**
   * Get execution stats
   */
  getStats() {
    const total = this.tradeHistory.length;
    const wins = this.tradeHistory.filter(t => t.won).length;
    const totalProfit = this.tradeHistory.reduce((sum, t) => sum + (t.profit || 0), 0);
    const avgProfit = total > 0 ? totalProfit / total : 0;

    return {
      totalTrades: total,
      wins,
      losses: total - wins,
      winRate: total > 0 ? wins / total : 0,
      totalProfit,
      avgProfit,
      openPositions: this.openTrades.size,
      currentBankroll: this.kelly.getBankroll(),
    };
  }

  private generateTradeId(): string {
    return `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
