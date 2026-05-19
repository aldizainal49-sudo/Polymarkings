export type MarketDirection = 'UP' | 'DOWN';
export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export interface Market {
  id: string;
  asset: Asset;
  direction: MarketDirection;
  startTime: number;
  endTime: number;
  currentPrice: number; // 0-1 probability
  volume: number;
  conditionId: string;
  tokenId: string;
}

export interface WalletProfile {
  address: string;
  totalTrades: number;
  winRate: number;
  avgBetSize: number;
  profitLoss: number;
  streak: number;
  lastActive: number;
  preferredAsset: Asset | null;
  preferredDirection: MarketDirection | null;
  avgHoldTime: number;
  patterns: WalletPattern[];
}

export interface WalletPattern {
  type: 'size_cluster' | 'timing' | 'asset_bias' | 'streak_bet' | 'contrarian' | 'momentum';
  confidence: number;
  details: Record<string, any>;
}

export interface TradeSignal {
  asset: Asset;
  direction: MarketDirection;
  confidence: number;
  edge: number;
  suggestedSize: number;
  sources: SignalSource[];
  timestamp: number;
}

export interface SignalSource {
  type: 'wallet_consensus' | 'mispricing' | 'pattern' | 'momentum';
  weight: number;
  details: string;
}

export interface TradeExecution {
  id: string;
  market: Market;
  direction: MarketDirection;
  size: number;
  entryPrice: number;
  exitPrice?: number;
  profit?: number;
  kellyFraction: number;
  timestamp: number;
  resolved: boolean;
  won?: boolean;
}

export interface KellyState {
  bankroll: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  kellyMultiplier: number;
  maxDrawdown: number;
  peakBankroll: number;
  consecutiveLosses: number;
  lastUpdated: number;
}

export interface MispricingSignal {
  asset: Asset;
  direction: MarketDirection;
  marketPrice: number;
  fairPrice: number;
  edge: number;
  confidence: number;
  walletConsensus: number; // % of top wallets agreeing
}

export interface BotStats {
  startTime: number;
  totalTrades: number;
  winRate: number;
  totalProfit: number;
  currentBankroll: number;
  walletsScanned: number;
  patternsDetected: number;
  mispricingsFound: number;
  uptime: number;
}
