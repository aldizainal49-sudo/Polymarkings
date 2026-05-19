import { config } from './config';
import { logger } from './config/logger';
import { KellyEngine } from './kelly/kelly-engine';
import { WalletScanner } from './scanner/wallet-scanner';
import { PatternEngine } from './patterns/pattern-engine';
import { TradeExecutor } from './trading/trade-executor';
import { PolymarketClient } from './trading/polymarket-client';
import { BotDatabase } from './storage/database';
import { Asset, BotStats } from './types';

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              POLYMARKINGS - AUTO TRADING BOT                  ║
 * ║                                                              ║
 * ║  Up/Down 5m Markets: BTC, ETH, SOL, XRP                     ║
 * ║  Kelly Criterion + 14,000 Wallet Scanner + Pattern AI        ║
 * ║                                                              ║
 * ║  $5 → $2,000 target | VPS mode | Adaptive learning          ║
 * ╚══════════════════════════════════════════════════════════════╝
 */
class Polymarkings {
  private client: PolymarketClient;
  private kelly: KellyEngine;
  private scanner: WalletScanner;
  private patterns: PatternEngine;
  private executor: TradeExecutor;
  private db: BotDatabase;

  private running: boolean = false;
  private loopInterval: NodeJS.Timeout | null = null;
  private scanInterval: NodeJS.Timeout | null = null;
  private startTime: number = 0;
  private runId: number = 0;

  constructor() {
    this.client = new PolymarketClient();
    this.kelly = new KellyEngine();
    this.scanner = new WalletScanner();
    this.patterns = new PatternEngine(this.scanner);
    this.executor = new TradeExecutor(this.client, this.kelly);
    this.db = new BotDatabase();
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    this.printBanner();
    this.startTime = Date.now();

    // Load saved state
    await this.loadState();

    // Initialize Polymarket client
    await this.client.initialize();

    // Check health
    const healthy = await this.client.isHealthy();
    if (!healthy) {
      logger.warn('⚠️  Polymarket API not reachable - starting in offline mode');
    }

    // Record run
    this.runId = this.db.startRun();

    // Initial wallet scan
    logger.info('📡 Running initial wallet scan...');
    try {
      await this.scanner.runFullScan();
    } catch (error: any) {
      logger.warn(`Initial scan failed: ${error.message} - will retry`);
    }

    // Start trading loop
    this.running = true;
    this.startTradingLoop();
    this.startScannerLoop();

    logger.info('\n🚀 POLYMARKINGS BOT STARTED');
    logger.info(`   Bankroll: $${this.kelly.getBankroll().toFixed(2)}`);
    logger.info(`   Assets: ${config.assets.join(', ')}`);
    logger.info(`   Mode: ${config.vpsMode ? 'VPS (24/7)' : 'Manual'}`);
    logger.info(`   Kelly Fraction: ${(config.kellyFraction * 100).toFixed(0)}%`);
    logger.info(`   Min Edge: ${(config.minEdge * 100).toFixed(0)}%`);
    logger.info('   Waiting for opportunities...\n');

    // Graceful shutdown
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  /**
   * Main trading loop - runs every market cycle
   */
  private startTradingLoop(): void {
    const LOOP_INTERVAL = 15000; // Check every 15 seconds

    this.loopInterval = setInterval(async () => {
      if (!this.running) return;

      try {
        // 1. Check and resolve expired trades
        await this.executor.checkExpiredTrades();

        // 2. Fetch active markets
        const markets = await this.client.getActiveMarkets();
        if (markets.length === 0) return;

        // 3. For each asset, generate signals and potentially trade
        for (const asset of config.assets as Asset[]) {
          const assetMarkets = markets.filter(m => m.asset === asset);
          if (assetMarkets.length === 0) continue;

          for (const market of assetMarkets) {
            // Get current price
            const price = await this.client.getMarketPrice(market.tokenId);
            market.currentPrice = price.mid;

            // Get recent trades for momentum
            const recentTrades = await this.client.getRecentTrades(market.conditionId, 20);

            // Generate signals
            const signals = await this.patterns.generateSignals(
              asset,
              market.currentPrice,
              recentTrades
            );

            // Execute best signal
            if (signals.length > 0) {
              const bestSignal = signals[0];
              bestSignal.suggestedSize = this.kelly.calculateBetSize(bestSignal);

              const trade = await this.executor.executeTrade(bestSignal, market);
              if (trade) {
                this.db.saveTrade(trade);
                this.db.saveKellyState(this.kelly.getState());
              }
            }
          }
        }

        // 4. Save state periodically
        this.db.saveKellyState(this.kelly.getState());

      } catch (error: any) {
        logger.error(`Trading loop error: ${error.message}`);
      }
    }, LOOP_INTERVAL);
  }

  /**
   * Periodic wallet scanner - refreshes wallet intelligence
   */
  private startScannerLoop(): void {
    this.scanInterval = setInterval(async () => {
      if (!this.running) return;
      if (!this.scanner.needsRefresh()) return;

      logger.info('🔄 Refreshing wallet data...');
      try {
        const wallets = await this.scanner.runFullScan();
        this.db.saveWalletProfiles(wallets);
      } catch (error: any) {
        logger.error(`Scanner refresh failed: ${error.message}`);
      }
    }, config.scannerRefreshInterval);
  }

  /**
   * Load saved state from database
   */
  private async loadState(): Promise<void> {
    // Load Kelly state
    const kellyState = this.db.loadKellyState();
    if (kellyState) {
      this.kelly.setState(kellyState);
      logger.info(`📁 Loaded Kelly state: $${kellyState.bankroll.toFixed(2)} bankroll, ${kellyState.totalTrades} trades`);
    }

    // Load signal performance
    const signalPerf = this.db.loadSignalPerformance();
    if (signalPerf.size > 0) {
      logger.info(`📁 Loaded signal performance: ${signalPerf.size} signal types tracked`);
    }
  }

  /**
   * Stop the bot gracefully
   */
  async stop(): Promise<void> {
    logger.info('\n⏹️  Stopping Polymarkings...');
    this.running = false;

    if (this.loopInterval) clearInterval(this.loopInterval);
    if (this.scanInterval) clearInterval(this.scanInterval);

    // Save final state
    this.db.saveKellyState(this.kelly.getState());
    const stats = this.executor.getStats();
    this.db.endRun(this.runId, stats.totalTrades, stats.totalProfit, this.scanner.getStats().totalScanned);

    // Print session summary
    this.printSummary();

    this.db.close();
    process.exit(0);
  }

  /**
   * Get current bot statistics
   */
  getStats(): BotStats {
    const execStats = this.executor.getStats();
    const scanStats = this.scanner.getStats();

    return {
      startTime: this.startTime,
      totalTrades: execStats.totalTrades,
      winRate: execStats.winRate,
      totalProfit: execStats.totalProfit,
      currentBankroll: this.kelly.getBankroll(),
      walletsScanned: scanStats.totalScanned,
      patternsDetected: scanStats.topWallets,
      mispricingsFound: this.patterns.getRecentMispricings(100).length,
      uptime: Date.now() - this.startTime,
    };
  }

  private printBanner(): void {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   ██████╗  ██████╗ ██╗  ██╗   ██╗███╗   ███╗ █████╗        ║
║   ██╔══██╗██╔═══██╗██║  ╚██╗ ██╔╝████╗ ████║██╔══██╗       ║
║   ██████╔╝██║   ██║██║   ╚████╔╝ ██╔████╔██║███████║       ║
║   ██╔═══╝ ██║   ██║██║    ╚██╔╝  ██║╚██╔╝██║██╔══██║       ║
║   ██║     ╚██████╔╝███████╗██║   ██║ ╚═╝ ██║██║  ██║       ║
║   ╚═╝      ╚═════╝ ╚══════╝╚═╝   ╚═╝     ╚═╝╚═╝  ╚═╝       ║
║                                                              ║
║   P O L Y M A R K I N G S  v1.0                             ║
║   Auto Trading Bot | Up/Down 5m | Kelly Criterion            ║
║   BTC • ETH • SOL • XRP                                     ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
  }

  private printSummary(): void {
    const stats = this.getStats();
    const uptime = Math.floor(stats.uptime / 60000);
    
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    SESSION SUMMARY                            ║
╠══════════════════════════════════════════════════════════════╣
║  Uptime:           ${String(uptime).padEnd(10)} minutes                     ║
║  Total Trades:     ${String(stats.totalTrades).padEnd(10)}                            ║
║  Win Rate:         ${(stats.winRate * 100).toFixed(1).padEnd(10)}%                           ║
║  Total Profit:     $${stats.totalProfit.toFixed(2).padEnd(9)}                            ║
║  Current Bankroll: $${stats.currentBankroll.toFixed(2).padEnd(9)}                            ║
║  Wallets Scanned:  ${String(stats.walletsScanned).padEnd(10)}                            ║
║  Patterns Found:   ${String(stats.patternsDetected).padEnd(10)}                            ║
║  Mispricings:      ${String(stats.mispricingsFound).padEnd(10)}                            ║
╚══════════════════════════════════════════════════════════════╝
    `);
  }
}

// === ENTRY POINT ===
async function main() {
  const bot = new Polymarkings();
  await bot.start();
}

main().catch(error => {
  logger.error(`Fatal error: ${error.message}`);
  console.error(error);
  process.exit(1);
});
