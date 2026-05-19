import axios from 'axios';
import { Asset, MarketDirection, WalletProfile, WalletPattern } from '../types';
import { config } from '../config';
import { logger } from '../config/logger';

/**
 * WALLET SCANNER
 * 
 * Memindai 14.000 dompet trading Up Or Down 5m dalam hitungan menit:
 * - Fetch active traders dari Polymarket CLOB API
 * - Batch processing untuk speed
 * - Profile setiap wallet: win rate, patterns, size clusters
 * - Rank wallets by profitability
 * - Cross-reference winning patterns
 */
export class WalletScanner {
  private walletProfiles: Map<string, WalletProfile> = new Map();
  private topWallets: WalletProfile[] = [];
  private scanInProgress: boolean = false;
  private lastScanTime: number = 0;
  private totalScanned: number = 0;

  private readonly API_BASE: string;
  private readonly BATCH_SIZE: number;
  private readonly TARGET_WALLETS: number;

  constructor() {
    this.API_BASE = config.polymarketApiUrl;
    this.BATCH_SIZE = config.scannerBatchSize;
    this.TARGET_WALLETS = config.scannerTargetWallets;
  }

  /**
   * Full scan: discover and profile all active Up/Down 5m traders
   */
  async runFullScan(): Promise<WalletProfile[]> {
    if (this.scanInProgress) {
      logger.warn('Scan already in progress, skipping');
      return this.topWallets;
    }

    this.scanInProgress = true;
    const startTime = Date.now();
    logger.info(`🔍 Starting full wallet scan - target: ${this.TARGET_WALLETS} wallets`);

    try {
      // Phase 1: Discover active wallets from recent Up/Down 5m markets
      const walletAddresses = await this.discoverActiveWallets();
      logger.info(`📡 Discovered ${walletAddresses.length} active wallets`);

      // Phase 2: Profile wallets in batches
      const profiles = await this.batchProfileWallets(walletAddresses);
      logger.info(`📊 Profiled ${profiles.length} wallets`);

      // Phase 3: Detect patterns for each wallet
      for (const profile of profiles) {
        profile.patterns = this.detectWalletPatterns(profile);
        this.walletProfiles.set(profile.address, profile);
      }

      // Phase 4: Rank and select top wallets
      this.topWallets = this.rankWallets(profiles);

      this.totalScanned = walletAddresses.length;
      this.lastScanTime = Date.now();

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`✅ Scan complete: ${this.totalScanned} wallets in ${elapsed}s | Top performers: ${this.topWallets.length}`);

      return this.topWallets;
    } catch (error: any) {
      logger.error(`Scan failed: ${error.message}`);
      throw error;
    } finally {
      this.scanInProgress = false;
    }
  }

  /**
   * Discover active wallets from Polymarket Up/Down 5m markets
   * Fetches trade history from recent markets to find active addresses
   */
  private async discoverActiveWallets(): Promise<string[]> {
    const wallets = new Set<string>();
    let cursor: string | null = null;
    let page = 0;

    while (wallets.size < this.TARGET_WALLETS) {
      try {
        // Fetch trades from Up/Down 5m markets
        const params: any = {
          market: 'Up/Down',
          limit: this.BATCH_SIZE,
        };
        if (cursor) params.cursor = cursor;

        const response = await axios.get(`${this.API_BASE}/trades`, {
          params,
          timeout: 10000,
        });

        const trades = response.data?.trades || response.data || [];
        if (!Array.isArray(trades) || trades.length === 0) break;

        for (const trade of trades) {
          if (trade.maker) wallets.add(trade.maker);
          if (trade.taker) wallets.add(trade.taker);
        }

        cursor = response.data?.next_cursor || null;
        page++;

        if (!cursor) break;
        if (page % 10 === 0) {
          logger.debug(`Discovery progress: ${wallets.size} wallets found (page ${page})`);
        }

        // Rate limiting
        await this.delay(100);
      } catch (error: any) {
        if (error.response?.status === 429) {
          logger.warn('Rate limited, waiting 5s...');
          await this.delay(5000);
          continue;
        }
        logger.error(`Discovery error on page ${page}: ${error.message}`);
        break;
      }
    }

    return Array.from(wallets).slice(0, this.TARGET_WALLETS);
  }

  /**
   * Profile wallets in parallel batches for speed
   */
  private async batchProfileWallets(addresses: string[]): Promise<WalletProfile[]> {
    const profiles: WalletProfile[] = [];
    const batches = this.chunkArray(addresses, this.BATCH_SIZE);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchProfiles = await Promise.allSettled(
        batch.map(addr => this.profileWallet(addr))
      );

      for (const result of batchProfiles) {
        if (result.status === 'fulfilled' && result.value) {
          profiles.push(result.value);
        }
      }

      if (i % 5 === 0) {
        logger.debug(`Profiling progress: ${profiles.length}/${addresses.length} (batch ${i + 1}/${batches.length})`);
      }

      // Rate limiting between batches
      await this.delay(200);
    }

    return profiles;
  }

  /**
   * Profile a single wallet - fetch trade history and compute stats
   */
  private async profileWallet(address: string): Promise<WalletProfile | null> {
    try {
      const response = await axios.get(`${this.API_BASE}/trades`, {
        params: {
          maker: address,
          limit: 200,
        },
        timeout: 8000,
      });

      const trades = response.data?.trades || response.data || [];
      if (!Array.isArray(trades) || trades.length < 3) return null;

      // Calculate wallet statistics
      let wins = 0;
      let losses = 0;
      let totalProfit = 0;
      let totalSize = 0;
      let assetCounts: Record<string, number> = {};
      let directionCounts: Record<string, number> = {};
      let streak = 0;
      let currentStreak = 0;
      let lastDirection: boolean | null = null;

      for (const trade of trades) {
        const size = parseFloat(trade.size || trade.amount || '0');
        totalSize += size;

        // Track asset preferences
        const asset = this.extractAssetFromMarket(trade.market || trade.condition_id || '');
        if (asset) {
          assetCounts[asset] = (assetCounts[asset] || 0) + 1;
        }

        // Track direction preferences
        const direction = this.extractDirectionFromTrade(trade);
        if (direction) {
          directionCounts[direction] = (directionCounts[direction] || 0) + 1;
        }

        // Track wins/losses (if resolved)
        if (trade.outcome !== undefined) {
          const won = trade.outcome === 'YES' || trade.profit > 0;
          if (won) {
            wins++;
            totalProfit += parseFloat(trade.profit || '0') || size * 0.8;
          } else {
            losses++;
            totalProfit -= size;
          }

          // Streak tracking
          if (lastDirection === won) {
            currentStreak++;
          } else {
            streak = Math.max(streak, currentStreak);
            currentStreak = 1;
          }
          lastDirection = won;
        }
      }

      const totalTrades = wins + losses;
      if (totalTrades < 3) return null;

      const winRate = wins / totalTrades;
      const avgBetSize = totalSize / trades.length;

      // Find preferred asset and direction
      const preferredAsset = Object.entries(assetCounts).sort((a, b) => b[1] - a[1])[0]?.[0] as Asset || null;
      const preferredDirection = Object.entries(directionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] as MarketDirection || null;

      return {
        address,
        totalTrades,
        winRate,
        avgBetSize,
        profitLoss: totalProfit,
        streak: Math.max(streak, currentStreak),
        lastActive: trades[0]?.timestamp ? new Date(trades[0].timestamp).getTime() : Date.now(),
        preferredAsset,
        preferredDirection,
        avgHoldTime: 300000, // 5m markets
        patterns: [], // filled later
      };
    } catch (error: any) {
      if (error.response?.status !== 429) {
        // Silently skip individual wallet errors
      }
      return null;
    }
  }

  /**
   * Detect trading patterns for a wallet
   */
  private detectWalletPatterns(profile: WalletProfile): WalletPattern[] {
    const patterns: WalletPattern[] = [];

    // Pattern 1: Size clustering - do they bet consistent sizes?
    if (profile.avgBetSize > 0) {
      patterns.push({
        type: 'size_cluster',
        confidence: Math.min(0.9, profile.totalTrades / 50),
        details: {
          avgSize: profile.avgBetSize,
          consistency: profile.totalTrades > 20 ? 'high' : 'medium',
        },
      });
    }

    // Pattern 2: Asset bias - strong preference for one asset
    if (profile.preferredAsset && profile.totalTrades > 10) {
      patterns.push({
        type: 'asset_bias',
        confidence: 0.7,
        details: {
          asset: profile.preferredAsset,
          direction: profile.preferredDirection,
        },
      });
    }

    // Pattern 3: Streak betting - increases size after wins
    if (profile.streak >= 3) {
      patterns.push({
        type: 'streak_bet',
        confidence: Math.min(0.85, profile.streak / 10),
        details: {
          maxStreak: profile.streak,
          type: profile.winRate > 0.5 ? 'momentum' : 'contrarian',
        },
      });
    }

    // Pattern 4: Contrarian - bets against market consensus
    if (profile.winRate > 0.55 && profile.preferredDirection) {
      patterns.push({
        type: 'contrarian',
        confidence: Math.min(0.8, (profile.winRate - 0.5) * 4),
        details: {
          winRate: profile.winRate,
          style: profile.winRate > 0.6 ? 'strong_contrarian' : 'mild_contrarian',
        },
      });
    }

    // Pattern 5: Momentum - follows recent direction
    if (profile.winRate > 0.52 && profile.totalTrades > 20) {
      patterns.push({
        type: 'momentum',
        confidence: Math.min(0.75, profile.winRate),
        details: {
          trades: profile.totalTrades,
          profitability: profile.profitLoss,
        },
      });
    }

    return patterns;
  }

  /**
   * Rank wallets by composite score
   */
  private rankWallets(profiles: WalletProfile[]): WalletProfile[] {
    return profiles
      .filter(p => p.totalTrades >= 5 && p.winRate > 0.45)
      .map(p => ({
        ...p,
        score: this.calculateWalletScore(p),
      }))
      .sort((a, b) => (b as any).score - (a as any).score)
      .slice(0, 1000); // Top 1000 wallets
  }

  /**
   * Composite scoring: cross-references win rate, pattern quality, and size
   */
  private calculateWalletScore(profile: WalletProfile): number {
    let score = 0;

    // Win rate (weighted heavily)
    score += (profile.winRate - 0.5) * 100;

    // Trade volume (more trades = more reliable data)
    score += Math.log(profile.totalTrades + 1) * 5;

    // Profitability
    score += Math.min(50, profile.profitLoss * 2);

    // Pattern quality
    const patternScore = profile.patterns.reduce((sum, p) => sum + p.confidence, 0);
    score += patternScore * 10;

    // Recency bonus (active in last hour)
    const hoursSinceActive = (Date.now() - profile.lastActive) / 3600000;
    if (hoursSinceActive < 1) score += 20;
    else if (hoursSinceActive < 6) score += 10;

    return score;
  }

  /**
   * Get consensus from top wallets on a specific market
   */
  getWalletConsensus(asset: Asset, direction: MarketDirection): { consensus: number; confidence: number; walletCount: number } {
    const relevantWallets = this.topWallets.filter(w => {
      if (w.preferredAsset && w.preferredAsset !== asset) return false;
      return w.winRate > 0.52;
    });

    if (relevantWallets.length === 0) {
      return { consensus: 0.5, confidence: 0, walletCount: 0 };
    }

    // Weighted consensus based on win rate
    let weightedVotes = 0;
    let totalWeight = 0;

    for (const wallet of relevantWallets) {
      const weight = wallet.winRate * Math.log(wallet.totalTrades + 1);
      const vote = wallet.preferredDirection === direction ? 1 : 0;
      weightedVotes += vote * weight;
      totalWeight += weight;
    }

    const consensus = totalWeight > 0 ? weightedVotes / totalWeight : 0.5;
    const confidence = Math.min(0.9, relevantWallets.length / 100);

    return {
      consensus,
      confidence,
      walletCount: relevantWallets.length,
    };
  }

  /**
   * Get top N performing wallets
   */
  getTopWallets(n: number = 50): WalletProfile[] {
    return this.topWallets.slice(0, n);
  }

  /**
   * Get wallet profile by address
   */
  getWalletProfile(address: string): WalletProfile | undefined {
    return this.walletProfiles.get(address);
  }

  /**
   * Get scan statistics
   */
  getStats() {
    return {
      totalScanned: this.totalScanned,
      profiledWallets: this.walletProfiles.size,
      topWallets: this.topWallets.length,
      lastScanTime: this.lastScanTime,
      scanInProgress: this.scanInProgress,
      avgWinRate: this.topWallets.length > 0
        ? this.topWallets.reduce((sum, w) => sum + w.winRate, 0) / this.topWallets.length
        : 0,
    };
  }

  /**
   * Check if scan data is stale and needs refresh
   */
  needsRefresh(): boolean {
    if (this.lastScanTime === 0) return true;
    return (Date.now() - this.lastScanTime) > config.scannerRefreshInterval;
  }

  // === UTILITY METHODS ===

  private extractAssetFromMarket(marketId: string): Asset | null {
    const lower = marketId.toLowerCase();
    if (lower.includes('btc') || lower.includes('bitcoin')) return 'BTC';
    if (lower.includes('eth') || lower.includes('ethereum')) return 'ETH';
    if (lower.includes('sol') || lower.includes('solana')) return 'SOL';
    if (lower.includes('xrp') || lower.includes('ripple')) return 'XRP';
    return null;
  }

  private extractDirectionFromTrade(trade: any): MarketDirection | null {
    const outcome = (trade.outcome || trade.side || '').toUpperCase();
    if (outcome.includes('UP') || outcome === 'YES' || outcome === 'BUY') return 'UP';
    if (outcome.includes('DOWN') || outcome === 'NO' || outcome === 'SELL') return 'DOWN';
    return null;
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
