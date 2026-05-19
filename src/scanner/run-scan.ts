import { WalletScanner } from './wallet-scanner';
import { logger } from '../config/logger';

/**
 * Standalone scanner runner
 * Usage: npx ts-node src/scanner/run-scan.ts
 */
async function main() {
  logger.info('🚀 Polymarkings Wallet Scanner - Standalone Mode');
  logger.info('================================================');

  const scanner = new WalletScanner();

  try {
    const topWallets = await scanner.runFullScan();

    logger.info('\n📊 SCAN RESULTS:');
    logger.info(`Total wallets scanned: ${scanner.getStats().totalScanned}`);
    logger.info(`Top wallets identified: ${topWallets.length}`);
    logger.info(`Average win rate (top): ${(scanner.getStats().avgWinRate * 100).toFixed(1)}%`);

    logger.info('\n🏆 TOP 20 WALLETS:');
    const top20 = scanner.getTopWallets(20);
    for (let i = 0; i < top20.length; i++) {
      const w = top20[i];
      logger.info(
        `#${i + 1} | ${w.address.slice(0, 8)}...${w.address.slice(-4)} | ` +
        `WR: ${(w.winRate * 100).toFixed(1)}% | ` +
        `Trades: ${w.totalTrades} | ` +
        `P/L: $${w.profitLoss.toFixed(2)} | ` +
        `Asset: ${w.preferredAsset || 'mixed'} | ` +
        `Patterns: ${w.patterns.length}`
      );
    }
  } catch (error: any) {
    logger.error(`Scanner failed: ${error.message}`);
    process.exit(1);
  }
}

main();
