import dotenv from 'dotenv';
dotenv.config();

export interface BotConfig {
  // Polymarket API
  polymarketApiUrl: string;
  polymarketWsUrl: string;
  privateKey: string;
  proxyAddress: string;

  // Trading params
  initialBankroll: number;
  maxBetFraction: number;
  minEdge: number;
  assets: string[];
  marketDuration: '5m';

  // Wallet scanner
  scannerBatchSize: number;
  scannerTargetWallets: number;
  scannerRefreshInterval: number;

  // Kelly tuning
  kellyFraction: number; // fraction of full kelly (0.25 = quarter kelly)
  minConfidence: number;
  maxDrawdownPct: number;

  // System
  logLevel: string;
  dbPath: string;
  vpsMode: boolean;
}

export const config: BotConfig = {
  polymarketApiUrl: process.env.POLYMARKET_API_URL || 'https://clob.polymarket.com',
  polymarketWsUrl: process.env.POLYMARKET_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  privateKey: process.env.PRIVATE_KEY || '',
  proxyAddress: process.env.PROXY_ADDRESS || '',

  initialBankroll: parseFloat(process.env.INITIAL_BANKROLL || '5'),
  maxBetFraction: parseFloat(process.env.MAX_BET_FRACTION || '0.15'),
  minEdge: parseFloat(process.env.MIN_EDGE || '0.03'),
  assets: (process.env.ASSETS || 'BTC,ETH,SOL,XRP').split(','),
  marketDuration: '5m',

  scannerBatchSize: parseInt(process.env.SCANNER_BATCH_SIZE || '500'),
  scannerTargetWallets: parseInt(process.env.SCANNER_TARGET_WALLETS || '14000'),
  scannerRefreshInterval: parseInt(process.env.SCANNER_REFRESH_INTERVAL || '300000'), // 5 min

  kellyFraction: parseFloat(process.env.KELLY_FRACTION || '0.25'),
  minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '0.55'),
  maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN_PCT || '0.5'),

  logLevel: process.env.LOG_LEVEL || 'info',
  dbPath: process.env.DB_PATH || './data/polymarkings.db',
  vpsMode: process.env.VPS_MODE === 'true',
};

export const SUPPORTED_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'] as const;
export type SupportedAsset = typeof SUPPORTED_ASSETS[number];
