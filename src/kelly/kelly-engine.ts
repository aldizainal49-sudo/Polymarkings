import { KellyState, TradeExecution, TradeSignal } from '../types';
import { config } from '../config';
import { logger } from '../config/logger';

/**
 * KELLY CRITERION ENGINE
 * 
 * Adaptive Kelly Criterion yang semakin pintar seiring waktu:
 * - Track win rate dan average win/loss secara real-time
 * - Adjust fraction berdasarkan recent performance
 * - Anti-tilt: reduce sizing after consecutive losses
 * - Learning: menyesuaikan confidence weight berdasarkan historical accuracy
 */
export class KellyEngine {
  private state: KellyState;
  private tradeHistory: TradeExecution[] = [];
  private recentWindow: number = 50; // last N trades for adaptive calculation
  private confidenceAccuracy: Map<string, { correct: number; total: number }> = new Map();

  constructor(initialBankroll?: number) {
    this.state = {
      bankroll: initialBankroll || config.initialBankroll,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0.5, // prior
      avgWin: 0.8, // prior: avg profit on win (as multiplier)
      avgLoss: 0.9, // prior: avg loss on loss (as multiplier)
      kellyMultiplier: config.kellyFraction,
      maxDrawdown: 0,
      peakBankroll: initialBankroll || config.initialBankroll,
      consecutiveLosses: 0,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Calculate optimal bet size using Kelly Criterion
   * f* = (p * b - q) / b
   * where p = probability of winning, b = odds (net profit/loss ratio), q = 1-p
   */
  calculateBetSize(signal: TradeSignal): number {
    const { confidence, edge } = signal;

    // Estimated probability of winning based on our edge calculation
    const p = Math.min(0.95, Math.max(0.51, confidence));
    const q = 1 - p;

    // Expected payout ratio (binary market: buy at price, win pays 1)
    // If market price is 0.50 and we think true prob is 0.60:
    // Buy at 0.50, win pays 1.00 -> profit = 0.50, loss = 0.50
    // b = profit/loss = 1 (for 50c market)
    const marketPrice = 1 - edge / confidence; // approximate market price
    const profitIfWin = 1 - marketPrice;
    const lossIfLose = marketPrice;
    const b = profitIfWin / lossIfLose;

    // Full Kelly fraction
    const fullKelly = (p * b - q) / b;

    if (fullKelly <= 0) {
      logger.debug('Kelly suggests no bet', { p, b, fullKelly, edge });
      return 0;
    }

    // Apply fractional Kelly (safer)
    let adjustedKelly = fullKelly * this.state.kellyMultiplier;

    // Anti-tilt: reduce after consecutive losses
    if (this.state.consecutiveLosses >= 3) {
      const tiltReduction = Math.pow(0.7, this.state.consecutiveLosses - 2);
      adjustedKelly *= tiltReduction;
      logger.info(`Anti-tilt active: ${this.state.consecutiveLosses} consecutive losses, reducing by ${(1 - tiltReduction) * 100}%`);
    }

    // Drawdown protection
    const drawdownPct = 1 - (this.state.bankroll / this.state.peakBankroll);
    if (drawdownPct > config.maxDrawdownPct * 0.7) {
      const drawdownReduction = 1 - (drawdownPct / config.maxDrawdownPct);
      adjustedKelly *= Math.max(0.1, drawdownReduction);
      logger.warn(`Drawdown protection: ${(drawdownPct * 100).toFixed(1)}% drawdown, reducing size`);
    }

    // Cap at max bet fraction
    adjustedKelly = Math.min(adjustedKelly, config.maxBetFraction);

    // Calculate dollar amount
    const betSize = Math.max(0.01, this.state.bankroll * adjustedKelly);

    logger.debug('Kelly calculation', {
      p: p.toFixed(4),
      b: b.toFixed(4),
      fullKelly: fullKelly.toFixed(4),
      adjustedKelly: adjustedKelly.toFixed(4),
      betSize: betSize.toFixed(4),
      bankroll: this.state.bankroll.toFixed(2),
    });

    return parseFloat(betSize.toFixed(2));
  }

  /**
   * Record trade result and update Kelly state adaptively
   */
  recordTradeResult(trade: TradeExecution): void {
    this.tradeHistory.push(trade);
    this.state.totalTrades++;

    if (trade.won) {
      this.state.wins++;
      this.state.consecutiveLosses = 0;
      this.state.bankroll += trade.profit || 0;
    } else {
      this.state.losses++;
      this.state.consecutiveLosses++;
      this.state.bankroll += trade.profit || 0; // profit is negative on loss
    }

    // Update peak and drawdown
    if (this.state.bankroll > this.state.peakBankroll) {
      this.state.peakBankroll = this.state.bankroll;
    }
    const currentDrawdown = 1 - (this.state.bankroll / this.state.peakBankroll);
    if (currentDrawdown > this.state.maxDrawdown) {
      this.state.maxDrawdown = currentDrawdown;
    }

    // Adaptive: recalculate stats based on recent trades
    this.updateAdaptiveStats();
    this.state.lastUpdated = Date.now();

    logger.info(`Trade recorded: ${trade.won ? 'WIN' : 'LOSS'} | P/L: $${(trade.profit || 0).toFixed(2)} | Bankroll: $${this.state.bankroll.toFixed(2)} | Win Rate: ${(this.state.winRate * 100).toFixed(1)}%`);
  }

  /**
   * Adaptive statistics based on sliding window
   * Semakin banyak trading, semakin akurat estimasi
   */
  private updateAdaptiveStats(): void {
    const recentTrades = this.tradeHistory.slice(-this.recentWindow);

    if (recentTrades.length < 5) return; // need minimum sample

    const wins = recentTrades.filter(t => t.won).length;
    const losses = recentTrades.length - wins;

    // Bayesian update: combine prior with observed data
    // More weight to observed data as sample size grows
    const sampleWeight = Math.min(0.9, recentTrades.length / 100);
    const observedWinRate = wins / recentTrades.length;
    this.state.winRate = (1 - sampleWeight) * 0.5 + sampleWeight * observedWinRate;

    // Update avg win/loss
    const winTrades = recentTrades.filter(t => t.won && t.profit);
    const lossTrades = recentTrades.filter(t => !t.won && t.profit);

    if (winTrades.length > 0) {
      this.state.avgWin = winTrades.reduce((sum, t) => sum + (t.profit || 0), 0) / winTrades.length;
    }
    if (lossTrades.length > 0) {
      this.state.avgLoss = Math.abs(lossTrades.reduce((sum, t) => sum + (t.profit || 0), 0) / lossTrades.length);
    }

    // Adaptive Kelly multiplier: increase when performing well, decrease when not
    if (recentTrades.length >= 20) {
      if (observedWinRate > 0.6 && this.state.consecutiveLosses === 0) {
        // Performing well - slowly increase kelly fraction
        this.state.kellyMultiplier = Math.min(0.5, this.state.kellyMultiplier * 1.02);
      } else if (observedWinRate < 0.45) {
        // Underperforming - reduce kelly fraction
        this.state.kellyMultiplier = Math.max(0.1, this.state.kellyMultiplier * 0.95);
      }
    }
  }

  /**
   * Track confidence calibration - learn how accurate our signals are
   */
  recordConfidenceResult(confidenceBucket: string, wasCorrect: boolean): void {
    if (!this.confidenceAccuracy.has(confidenceBucket)) {
      this.confidenceAccuracy.set(confidenceBucket, { correct: 0, total: 0 });
    }
    const bucket = this.confidenceAccuracy.get(confidenceBucket)!;
    bucket.total++;
    if (wasCorrect) bucket.correct++;
  }

  /**
   * Get calibrated confidence (how accurate are our signals at this level?)
   */
  getCalibratedConfidence(rawConfidence: number): number {
    const bucket = `${Math.floor(rawConfidence * 10) / 10}`;
    const record = this.confidenceAccuracy.get(bucket);
    if (!record || record.total < 10) return rawConfidence; // not enough data yet
    const calibrated = record.correct / record.total;
    // Blend raw and calibrated
    const weight = Math.min(0.8, record.total / 50);
    return (1 - weight) * rawConfidence + weight * calibrated;
  }

  /**
   * Should we trade? Check bankroll constraints
   */
  canTrade(): boolean {
    if (this.state.bankroll < 0.5) {
      logger.warn('Bankroll too low to trade');
      return false;
    }
    const drawdown = 1 - (this.state.bankroll / this.state.peakBankroll);
    if (drawdown > config.maxDrawdownPct) {
      logger.warn(`Max drawdown reached: ${(drawdown * 100).toFixed(1)}%`);
      return false;
    }
    return true;
  }

  getState(): KellyState {
    return { ...this.state };
  }

  getBankroll(): number {
    return this.state.bankroll;
  }

  getTradeCount(): number {
    return this.state.totalTrades;
  }

  setState(state: KellyState): void {
    this.state = { ...state };
  }

  setTradeHistory(trades: TradeExecution[]): void {
    this.tradeHistory = trades;
    this.updateAdaptiveStats();
  }
}
