import { Asset, MarketDirection, MispricingSignal, TradeSignal, SignalSource, WalletProfile } from '../types';
import { config } from '../config';
import { logger } from '../config/logger';
import { WalletScanner } from '../scanner/wallet-scanner';

/**
 * PATTERN DETECTION & MISPRICING ENGINE
 * 
 * Mendeteksi pola-pola pemenang dan melihat kesalahan harga:
 * - Cross-reference win rates dari top wallets
 * - Detect size pattern clusters (big money moving)
 * - Identify mispricing vs fair value
 * - Momentum detection (trend following)
 * - Contrarian signals (when smart money disagrees with market)
 * - Time-based patterns (certain times more predictable)
 */
export class PatternEngine {
  private scanner: WalletScanner;
  private signalHistory: TradeSignal[] = [];
  private mispricingHistory: MispricingSignal[] = [];
  
  // Learning: track which signal types perform best
  private signalPerformance: Map<string, { wins: number; total: number }> = new Map();

  constructor(scanner: WalletScanner) {
    this.scanner = scanner;
  }

  /**
   * Generate trade signals by combining multiple pattern detectors
   */
  async generateSignals(
    asset: Asset,
    currentMarketPrice: number, // current UP price (0-1)
    recentTrades?: any[]
  ): Promise<TradeSignal[]> {
    const signals: TradeSignal[] = [];

    // Signal 1: Wallet Consensus
    const consensusSignal = this.analyzeWalletConsensus(asset, currentMarketPrice);
    if (consensusSignal) signals.push(consensusSignal);

    // Signal 2: Mispricing Detection
    const mispricingSignal = this.detectMispricing(asset, currentMarketPrice);
    if (mispricingSignal) signals.push(mispricingSignal);

    // Signal 3: Size Pattern Analysis
    const sizeSignal = this.analyzeSizePatterns(asset, currentMarketPrice);
    if (sizeSignal) signals.push(sizeSignal);

    // Signal 4: Momentum
    if (recentTrades && recentTrades.length > 0) {
      const momentumSignal = this.detectMomentum(asset, recentTrades, currentMarketPrice);
      if (momentumSignal) signals.push(momentumSignal);
    }

    // Signal 5: Contrarian (smart money vs market)
    const contrarianSignal = this.detectContrarianOpportunity(asset, currentMarketPrice);
    if (contrarianSignal) signals.push(contrarianSignal);

    // Combine signals into composite signal if enough agree
    const compositeSignal = this.combineSignals(asset, signals, currentMarketPrice);
    if (compositeSignal) {
      this.signalHistory.push(compositeSignal);
      return [compositeSignal];
    }

    return [];
  }

  /**
   * Signal 1: Wallet Consensus Analysis
   * Menyilangkan referensi tingkat kemenangan dari top wallets
   */
  private analyzeWalletConsensus(asset: Asset, marketPrice: number): TradeSignal | null {
    const upConsensus = this.scanner.getWalletConsensus(asset, 'UP');
    const downConsensus = this.scanner.getWalletConsensus(asset, 'DOWN');

    if (upConsensus.walletCount < 5 && downConsensus.walletCount < 5) return null;

    let direction: MarketDirection;
    let consensus: number;
    let walletCount: number;

    if (upConsensus.consensus > downConsensus.consensus) {
      direction = 'UP';
      consensus = upConsensus.consensus;
      walletCount = upConsensus.walletCount;
    } else {
      direction = 'DOWN';
      consensus = downConsensus.consensus;
      walletCount = downConsensus.walletCount;
    }

    // Calculate edge: difference between wallet consensus and market price
    const fairPrice = consensus;
    const currentPrice = direction === 'UP' ? marketPrice : 1 - marketPrice;
    const edge = fairPrice - currentPrice;

    if (edge < config.minEdge) return null;

    const confidence = Math.min(0.85, consensus * upConsensus.confidence);

    return {
      asset,
      direction,
      confidence,
      edge,
      suggestedSize: 0, // Kelly will calculate
      sources: [{
        type: 'wallet_consensus',
        weight: 0.4,
        details: `${walletCount} wallets, ${(consensus * 100).toFixed(1)}% consensus for ${direction}`,
      }],
      timestamp: Date.now(),
    };
  }

  /**
   * Signal 2: Mispricing Detection
   * Melihat kesalahan harga - when market price deviates from fair value
   */
  private detectMispricing(asset: Asset, marketPrice: number): TradeSignal | null {
    // Calculate fair value from multiple inputs
    const topWallets = this.scanner.getTopWallets(100);
    const relevantWallets = topWallets.filter(w => 
      !w.preferredAsset || w.preferredAsset === asset
    );

    if (relevantWallets.length < 10) return null;

    // Weighted fair value from top wallet behavior
    let weightedFairValue = 0;
    let totalWeight = 0;

    for (const wallet of relevantWallets) {
      const weight = wallet.winRate * Math.sqrt(wallet.totalTrades);
      const walletImpliedProb = wallet.preferredDirection === 'UP' 
        ? Math.min(0.9, wallet.winRate + 0.1)
        : Math.max(0.1, 1 - wallet.winRate - 0.1);
      
      weightedFairValue += walletImpliedProb * weight;
      totalWeight += weight;
    }

    const fairPrice = totalWeight > 0 ? weightedFairValue / totalWeight : 0.5;
    const edge = Math.abs(fairPrice - marketPrice);

    if (edge < config.minEdge) return null;

    const direction: MarketDirection = fairPrice > marketPrice ? 'UP' : 'DOWN';
    const confidence = Math.min(0.8, 0.5 + edge);

    // Store mispricing for tracking
    this.mispricingHistory.push({
      asset,
      direction,
      marketPrice,
      fairPrice,
      edge,
      confidence,
      walletConsensus: relevantWallets.length / topWallets.length,
    });

    logger.info(`💰 Mispricing detected: ${asset} ${direction} | Market: ${(marketPrice * 100).toFixed(1)}% | Fair: ${(fairPrice * 100).toFixed(1)}% | Edge: ${(edge * 100).toFixed(1)}%`);

    return {
      asset,
      direction,
      confidence,
      edge,
      suggestedSize: 0,
      sources: [{
        type: 'mispricing',
        weight: 0.35,
        details: `Fair value ${(fairPrice * 100).toFixed(1)}% vs market ${(marketPrice * 100).toFixed(1)}%, edge ${(edge * 100).toFixed(1)}%`,
      }],
      timestamp: Date.now(),
    };
  }

  /**
   * Signal 3: Size Pattern Analysis
   * Menyilangkan referensi pola ukuran - detect when big money is entering
   */
  private analyzeSizePatterns(asset: Asset, marketPrice: number): TradeSignal | null {
    const topWallets = this.scanner.getTopWallets(50);
    
    // Look for wallets with large recent positions
    const bigBettors = topWallets.filter(w => 
      w.avgBetSize > 10 && // $10+ average bets
      w.winRate > 0.55 &&
      (Date.now() - w.lastActive) < 600000 // active in last 10 min
    );

    if (bigBettors.length < 3) return null;

    // What direction are big bettors favoring?
    let upVotes = 0;
    let downVotes = 0;
    let totalSize = 0;

    for (const wallet of bigBettors) {
      const size = wallet.avgBetSize;
      totalSize += size;
      if (wallet.preferredDirection === 'UP') upVotes += size;
      else if (wallet.preferredDirection === 'DOWN') downVotes += size;
    }

    if (totalSize === 0) return null;

    const upRatio = upVotes / totalSize;
    const direction: MarketDirection = upRatio > 0.6 ? 'UP' : upRatio < 0.4 ? 'DOWN' : 'UP';
    const skew = Math.abs(upRatio - 0.5) * 2; // 0-1 how skewed

    if (skew < 0.2) return null; // not enough conviction

    const edge = skew * 0.1; // conservative edge estimate
    const confidence = Math.min(0.75, 0.5 + skew * 0.3);

    return {
      asset,
      direction,
      confidence,
      edge,
      suggestedSize: 0,
      sources: [{
        type: 'pattern',
        weight: 0.15,
        details: `${bigBettors.length} big bettors ($${totalSize.toFixed(0)} total), ${(skew * 100).toFixed(0)}% skew ${direction}`,
      }],
      timestamp: Date.now(),
    };
  }

  /**
   * Signal 4: Momentum Detection
   * Detect if recent trades show strong directional momentum
   */
  private detectMomentum(asset: Asset, recentTrades: any[], marketPrice: number): TradeSignal | null {
    if (recentTrades.length < 5) return null;

    // Analyze last N trades for direction
    let upCount = 0;
    let downCount = 0;
    let volumeUp = 0;
    let volumeDown = 0;

    for (const trade of recentTrades.slice(-20)) {
      const size = parseFloat(trade.size || trade.amount || '1');
      const side = (trade.side || trade.outcome || '').toUpperCase();
      
      if (side.includes('BUY') || side.includes('UP') || side === 'YES') {
        upCount++;
        volumeUp += size;
      } else {
        downCount++;
        volumeDown += size;
      }
    }

    const totalTrades = upCount + downCount;
    if (totalTrades < 5) return null;

    const momentumRatio = upCount / totalTrades;
    const volumeRatio = volumeUp / (volumeUp + volumeDown || 1);

    // Strong momentum = both trade count and volume agree
    const combinedMomentum = (momentumRatio + volumeRatio) / 2;
    const direction: MarketDirection = combinedMomentum > 0.6 ? 'UP' : combinedMomentum < 0.4 ? 'DOWN' : 'UP';
    const strength = Math.abs(combinedMomentum - 0.5) * 2;

    if (strength < 0.2) return null;

    const edge = strength * 0.05;
    const confidence = Math.min(0.7, 0.5 + strength * 0.25);

    return {
      asset,
      direction,
      confidence,
      edge,
      suggestedSize: 0,
      sources: [{
        type: 'momentum',
        weight: 0.1,
        details: `${totalTrades} recent trades, ${(combinedMomentum * 100).toFixed(0)}% ${direction} momentum`,
      }],
      timestamp: Date.now(),
    };
  }

  /**
   * Signal 5: Contrarian Opportunity
   * When smart wallets disagree with market price significantly
   */
  private detectContrarianOpportunity(asset: Asset, marketPrice: number): TradeSignal | null {
    const topWallets = this.scanner.getTopWallets(30);
    const smartWallets = topWallets.filter(w => w.winRate > 0.6 && w.totalTrades > 30);

    if (smartWallets.length < 5) return null;

    // Check if smart money is taking opposite position to market
    let contrarians = 0;
    for (const wallet of smartWallets) {
      const marketFavors: MarketDirection = marketPrice > 0.55 ? 'UP' : marketPrice < 0.45 ? 'DOWN' : 'UP';
      if (wallet.preferredDirection && wallet.preferredDirection !== marketFavors) {
        contrarians++;
      }
    }

    const contrarianRatio = contrarians / smartWallets.length;
    if (contrarianRatio < 0.5) return null; // not enough contrarians

    // Smart money disagrees with market
    const direction: MarketDirection = marketPrice > 0.55 ? 'DOWN' : 'UP';
    const edge = contrarianRatio * 0.08;
    const confidence = Math.min(0.75, 0.5 + contrarianRatio * 0.3);

    logger.info(`🔄 Contrarian signal: ${contrarians}/${smartWallets.length} smart wallets betting ${direction} (market at ${(marketPrice * 100).toFixed(1)}%)`);

    return {
      asset,
      direction,
      confidence,
      edge,
      suggestedSize: 0,
      sources: [{
        type: 'wallet_consensus',
        weight: 0.2,
        details: `${contrarians} smart wallets (>${60}% WR) going contrarian ${direction}`,
      }],
      timestamp: Date.now(),
    };
  }

  /**
   * Combine multiple signals into one composite signal
   * Only triggers if enough evidence agrees
   */
  private combineSignals(asset: Asset, signals: TradeSignal[], marketPrice: number): TradeSignal | null {
    if (signals.length === 0) return null;

    // Count direction votes weighted by confidence
    let upScore = 0;
    let downScore = 0;
    const allSources: SignalSource[] = [];

    for (const signal of signals) {
      const weight = signal.confidence * signal.edge;
      if (signal.direction === 'UP') upScore += weight;
      else downScore += weight;
      allSources.push(...signal.sources);
    }

    const totalScore = upScore + downScore;
    if (totalScore === 0) return null;

    const direction: MarketDirection = upScore > downScore ? 'UP' : 'DOWN';
    const dominantScore = Math.max(upScore, downScore);
    const agreement = dominantScore / totalScore;

    // Need at least 60% agreement
    if (agreement < 0.6) return null;

    // Combined confidence and edge
    const relevantSignals = signals.filter(s => s.direction === direction);
    const avgConfidence = relevantSignals.reduce((sum, s) => sum + s.confidence, 0) / relevantSignals.length;
    const maxEdge = Math.max(...relevantSignals.map(s => s.edge));
    const avgEdge = relevantSignals.reduce((sum, s) => sum + s.edge, 0) / relevantSignals.length;

    // Boost confidence when multiple signals agree
    const multiSignalBoost = Math.min(0.1, (relevantSignals.length - 1) * 0.03);
    const finalConfidence = Math.min(0.9, avgConfidence + multiSignalBoost);
    const finalEdge = avgEdge;

    // Must meet minimum thresholds
    if (finalConfidence < config.minConfidence) return null;
    if (finalEdge < config.minEdge) return null;

    // Apply learned performance weights
    const calibratedConfidence = this.applyPerformanceCalibration(finalConfidence, allSources);

    return {
      asset,
      direction,
      confidence: calibratedConfidence,
      edge: finalEdge,
      suggestedSize: 0, // Kelly calculates
      sources: allSources,
      timestamp: Date.now(),
    };
  }

  /**
   * Calibrate confidence based on historical signal performance
   * Semakin sering trading, semakin pintar
   */
  private applyPerformanceCalibration(confidence: number, sources: SignalSource[]): number {
    let adjustment = 0;
    let count = 0;

    for (const source of sources) {
      const perf = this.signalPerformance.get(source.type);
      if (perf && perf.total >= 10) {
        const accuracy = perf.wins / perf.total;
        // If this signal type historically overestimates, reduce
        // If it underestimates, increase
        adjustment += (accuracy - 0.5) * 0.2;
        count++;
      }
    }

    if (count === 0) return confidence;
    return Math.min(0.9, Math.max(0.1, confidence + adjustment / count));
  }

  /**
   * Record signal outcome for learning
   */
  recordSignalResult(signal: TradeSignal, won: boolean): void {
    for (const source of signal.sources) {
      if (!this.signalPerformance.has(source.type)) {
        this.signalPerformance.set(source.type, { wins: 0, total: 0 });
      }
      const perf = this.signalPerformance.get(source.type)!;
      perf.total++;
      if (won) perf.wins++;
    }
  }

  /**
   * Get signal performance stats
   */
  getPerformanceStats(): Record<string, { winRate: number; total: number }> {
    const stats: Record<string, { winRate: number; total: number }> = {};
    for (const [type, perf] of this.signalPerformance) {
      stats[type] = {
        winRate: perf.total > 0 ? perf.wins / perf.total : 0,
        total: perf.total,
      };
    }
    return stats;
  }

  /**
   * Get recent mispricing signals
   */
  getRecentMispricings(limit: number = 10): MispricingSignal[] {
    return this.mispricingHistory.slice(-limit);
  }
}
