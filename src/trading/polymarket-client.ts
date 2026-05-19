import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { Asset, Market, MarketDirection } from '../types';
import { config } from '../config';
import { logger } from '../config/logger';

/**
 * POLYMARKET CLOB API CLIENT
 * 
 * Interfaces with Polymarket's CLOB (Central Limit Order Book) for:
 * - Fetching Up/Down 5m markets (BTC, ETH, SOL, XRP)
 * - Placing limit/market orders
 * - Checking positions and balances
 * - Streaming market data via WebSocket
 */
export class PolymarketClient {
  private api: AxiosInstance;
  private wallet: ethers.Wallet | null = null;
  private signer: ethers.Signer | null = null;
  private apiKey: string = '';
  private apiSecret: string = '';

  constructor() {
    this.api = axios.create({
      baseURL: config.polymarketApiUrl,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Initialize wallet and authentication
   */
  async initialize(): Promise<void> {
    if (!config.privateKey) {
      logger.warn('No private key configured - running in read-only mode');
      return;
    }

    try {
      this.wallet = new ethers.Wallet(config.privateKey);
      this.signer = this.wallet;

      // Generate API credentials (HMAC-based auth for Polymarket CLOB)
      await this.authenticate();
      logger.info(`✅ Polymarket client initialized | Wallet: ${this.wallet.address.slice(0, 8)}...`);
    } catch (error: any) {
      logger.error(`Failed to initialize Polymarket client: ${error.message}`);
      throw error;
    }
  }

  /**
   * Authenticate with Polymarket CLOB API
   */
  private async authenticate(): Promise<void> {
    if (!this.wallet) return;

    try {
      // Create API key via signature
      const timestamp = Math.floor(Date.now() / 1000);
      const message = `Login to Polymarket CLOB\nTimestamp: ${timestamp}`;
      const signature = await this.wallet.signMessage(message);

      const response = await this.api.post('/auth/api-key', {
        address: this.wallet.address,
        signature,
        timestamp,
        nonce: 0,
      });

      if (response.data?.apiKey) {
        this.apiKey = response.data.apiKey;
        this.apiSecret = response.data.secret || '';
        this.api.defaults.headers.common['Authorization'] = `Bearer ${this.apiKey}`;
        this.api.defaults.headers.common['X-Api-Key'] = this.apiKey;
      }
    } catch (error: any) {
      logger.warn(`Auth attempt failed (may need manual API key): ${error.message}`);
      // Allow continuing in read-only mode
    }
  }

  /**
   * Fetch active Up/Down 5m markets for supported assets
   */
  async getActiveMarkets(): Promise<Market[]> {
    const markets: Market[] = [];

    try {
      // Fetch markets matching Up/Down 5m pattern
      const response = await this.api.get('/markets', {
        params: {
          active: true,
          closed: false,
          limit: 100,
        },
      });

      const rawMarkets = response.data || [];
      
      for (const raw of rawMarkets) {
        const market = this.parseUpDownMarket(raw);
        if (market) markets.push(market);
      }

      logger.debug(`Found ${markets.length} active Up/Down 5m markets`);
    } catch (error: any) {
      logger.error(`Failed to fetch markets: ${error.message}`);
    }

    return markets;
  }

  /**
   * Get current price/odds for a specific market
   */
  async getMarketPrice(tokenId: string): Promise<{ bid: number; ask: number; mid: number }> {
    try {
      const response = await this.api.get(`/book`, {
        params: { token_id: tokenId },
      });

      const book = response.data;
      const bestBid = book?.bids?.[0]?.price ? parseFloat(book.bids[0].price) : 0;
      const bestAsk = book?.asks?.[0]?.price ? parseFloat(book.asks[0].price) : 1;
      const mid = (bestBid + bestAsk) / 2;

      return { bid: bestBid, ask: bestAsk, mid };
    } catch (error: any) {
      logger.error(`Failed to get price for ${tokenId}: ${error.message}`);
      return { bid: 0, ask: 1, mid: 0.5 };
    }
  }

  /**
   * Get recent trades for a market
   */
  async getRecentTrades(conditionId: string, limit: number = 50): Promise<any[]> {
    try {
      const response = await this.api.get('/trades', {
        params: {
          condition_id: conditionId,
          limit,
        },
      });

      return response.data?.trades || response.data || [];
    } catch (error: any) {
      logger.error(`Failed to get trades: ${error.message}`);
      return [];
    }
  }

  /**
   * Place a market order (buy YES/NO tokens)
   */
  async placeOrder(params: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    size: number;
    price?: number; // limit price, omit for market order
    orderType?: 'GTC' | 'FOK' | 'GTD';
  }): Promise<{ orderId: string; filled: boolean; avgPrice: number } | null> {
    if (!this.apiKey) {
      logger.error('Cannot place order: not authenticated');
      return null;
    }

    try {
      const orderPayload: any = {
        tokenID: params.tokenId,
        side: params.side,
        size: params.size.toString(),
        type: params.price ? 'LIMIT' : 'MARKET',
        orderType: params.orderType || 'FOK', // Fill or Kill for market orders
      };

      if (params.price) {
        orderPayload.price = params.price.toString();
      }

      // Sign the order
      if (this.wallet) {
        const orderHash = ethers.keccak256(
          ethers.toUtf8Bytes(JSON.stringify(orderPayload))
        );
        orderPayload.signature = await this.wallet.signMessage(
          ethers.getBytes(orderHash)
        );
      }

      const response = await this.api.post('/order', orderPayload);

      const result = {
        orderId: response.data?.orderID || response.data?.id || '',
        filled: response.data?.status === 'FILLED' || response.data?.status === 'MATCHED',
        avgPrice: parseFloat(response.data?.price || response.data?.avgPrice || '0'),
      };

      logger.info(`📝 Order placed: ${params.side} ${params.size} @ ${params.price || 'MARKET'} | ID: ${result.orderId} | Filled: ${result.filled}`);
      return result;
    } catch (error: any) {
      logger.error(`Order failed: ${error.response?.data?.message || error.message}`);
      return null;
    }
  }

  /**
   * Cancel an open order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.api.delete(`/order/${orderId}`);
      logger.info(`❌ Order cancelled: ${orderId}`);
      return true;
    } catch (error: any) {
      logger.error(`Cancel failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get current positions
   */
  async getPositions(): Promise<any[]> {
    try {
      const response = await this.api.get('/positions');
      return response.data || [];
    } catch (error: any) {
      logger.error(`Failed to get positions: ${error.message}`);
      return [];
    }
  }

  /**
   * Get USDC balance
   */
  async getBalance(): Promise<number> {
    try {
      const response = await this.api.get('/balance');
      return parseFloat(response.data?.balance || '0');
    } catch (error: any) {
      logger.error(`Failed to get balance: ${error.message}`);
      return 0;
    }
  }

  /**
   * Parse raw market data to identify Up/Down 5m markets
   */
  private parseUpDownMarket(raw: any): Market | null {
    const question = (raw.question || raw.title || raw.description || '').toLowerCase();
    
    // Must be an Up/Down market with 5 minute duration
    const isUpDown = question.includes('up') || question.includes('down') || 
                     question.includes('higher') || question.includes('lower');
    const is5min = question.includes('5 min') || question.includes('5min') || 
                   question.includes('5 minute') || question.includes('five min');

    if (!isUpDown || !is5min) return null;

    // Identify asset
    let asset: Asset | null = null;
    if (question.includes('btc') || question.includes('bitcoin')) asset = 'BTC';
    else if (question.includes('eth') || question.includes('ethereum')) asset = 'ETH';
    else if (question.includes('sol') || question.includes('solana')) asset = 'SOL';
    else if (question.includes('xrp') || question.includes('ripple')) asset = 'XRP';

    if (!asset) return null;
    if (!config.assets.includes(asset)) return null;

    // Determine direction
    const direction: MarketDirection = question.includes('up') || question.includes('higher') ? 'UP' : 'DOWN';

    return {
      id: raw.id || raw.condition_id || '',
      asset,
      direction,
      startTime: raw.start_date ? new Date(raw.start_date).getTime() : Date.now(),
      endTime: raw.end_date ? new Date(raw.end_date).getTime() : Date.now() + 300000,
      currentPrice: parseFloat(raw.price || raw.last_price || '0.5'),
      volume: parseFloat(raw.volume || raw.total_volume || '0'),
      conditionId: raw.condition_id || raw.id || '',
      tokenId: raw.token_id || raw.tokens?.[0]?.token_id || '',
    };
  }

  /**
   * Health check
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.api.get('/time');
      return true;
    } catch {
      return false;
    }
  }
}
