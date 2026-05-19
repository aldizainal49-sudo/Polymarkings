import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { KellyState, TradeExecution, WalletProfile } from '../types';
import { config } from '../config';
import { logger } from '../config/logger';

/**
 * DATABASE LAYER
 * 
 * Persistent storage for bot state:
 * - Trade history (for learning)
 * - Kelly state (resume after restart)
 * - Wallet profiles (cache between scans)
 * - Signal performance (learning data)
 */
export class BotDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || config.dbPath;
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        asset TEXT NOT NULL,
        direction TEXT NOT NULL,
        size REAL NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL,
        profit REAL,
        kelly_fraction REAL NOT NULL,
        won INTEGER,
        resolved INTEGER DEFAULT 0,
        timestamp INTEGER NOT NULL,
        market_id TEXT,
        condition_id TEXT
      );

      CREATE TABLE IF NOT EXISTS kelly_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        bankroll REAL NOT NULL,
        total_trades INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        win_rate REAL DEFAULT 0.5,
        avg_win REAL DEFAULT 0.8,
        avg_loss REAL DEFAULT 0.9,
        kelly_multiplier REAL DEFAULT 0.25,
        max_drawdown REAL DEFAULT 0,
        peak_bankroll REAL,
        consecutive_losses INTEGER DEFAULT 0,
        last_updated INTEGER
      );

      CREATE TABLE IF NOT EXISTS wallet_profiles (
        address TEXT PRIMARY KEY,
        total_trades INTEGER,
        win_rate REAL,
        avg_bet_size REAL,
        profit_loss REAL,
        streak INTEGER,
        last_active INTEGER,
        preferred_asset TEXT,
        preferred_direction TEXT,
        patterns TEXT,
        score REAL,
        last_scanned INTEGER
      );

      CREATE TABLE IF NOT EXISTS signal_performance (
        signal_type TEXT PRIMARY KEY,
        wins INTEGER DEFAULT 0,
        total INTEGER DEFAULT 0,
        last_updated INTEGER
      );

      CREATE TABLE IF NOT EXISTS bot_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        trades_executed INTEGER DEFAULT 0,
        profit_loss REAL DEFAULT 0,
        wallets_scanned INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
      CREATE INDEX IF NOT EXISTS idx_trades_asset ON trades(asset);
      CREATE INDEX IF NOT EXISTS idx_wallet_score ON wallet_profiles(score);
    `);

    logger.debug('Database tables initialized');
  }

  // === KELLY STATE ===

  saveKellyState(state: KellyState): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO kelly_state 
      (id, bankroll, total_trades, wins, losses, win_rate, avg_win, avg_loss, 
       kelly_multiplier, max_drawdown, peak_bankroll, consecutive_losses, last_updated)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      state.bankroll, state.totalTrades, state.wins, state.losses,
      state.winRate, state.avgWin, state.avgLoss, state.kellyMultiplier,
      state.maxDrawdown, state.peakBankroll, state.consecutiveLosses, state.lastUpdated
    );
  }

  loadKellyState(): KellyState | null {
    const row = this.db.prepare('SELECT * FROM kelly_state WHERE id = 1').get() as any;
    if (!row) return null;
    return {
      bankroll: row.bankroll,
      totalTrades: row.total_trades,
      wins: row.wins,
      losses: row.losses,
      winRate: row.win_rate,
      avgWin: row.avg_win,
      avgLoss: row.avg_loss,
      kellyMultiplier: row.kelly_multiplier,
      maxDrawdown: row.max_drawdown,
      peakBankroll: row.peak_bankroll,
      consecutiveLosses: row.consecutive_losses,
      lastUpdated: row.last_updated,
    };
  }

  // === TRADES ===

  saveTrade(trade: TradeExecution): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO trades 
      (id, asset, direction, size, entry_price, exit_price, profit, 
       kelly_fraction, won, resolved, timestamp, market_id, condition_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      trade.id, trade.market.asset, trade.direction, trade.size,
      trade.entryPrice, trade.exitPrice || null, trade.profit || null,
      trade.kellyFraction, trade.won ? 1 : 0, trade.resolved ? 1 : 0,
      trade.timestamp, trade.market.id, trade.market.conditionId
    );
  }

  getTradeHistory(limit: number = 100): any[] {
    return this.db.prepare(
      'SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?'
    ).all(limit);
  }

  getTradeStats(): { total: number; wins: number; profit: number } {
    const row = this.db.prepare(`
      SELECT COUNT(*) as total, 
             SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END) as wins,
             SUM(COALESCE(profit, 0)) as profit
      FROM trades WHERE resolved = 1
    `).get() as any;
    return { total: row.total || 0, wins: row.wins || 0, profit: row.profit || 0 };
  }

  // === WALLET PROFILES ===

  saveWalletProfiles(profiles: WalletProfile[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO wallet_profiles 
      (address, total_trades, win_rate, avg_bet_size, profit_loss, streak,
       last_active, preferred_asset, preferred_direction, patterns, score, last_scanned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((profiles: WalletProfile[]) => {
      for (const p of profiles) {
        stmt.run(
          p.address, p.totalTrades, p.winRate, p.avgBetSize, p.profitLoss,
          p.streak, p.lastActive, p.preferredAsset, p.preferredDirection,
          JSON.stringify(p.patterns), 0, Date.now()
        );
      }
    });

    insertMany(profiles);
    logger.debug(`Saved ${profiles.length} wallet profiles to database`);
  }

  loadTopWallets(limit: number = 1000): WalletProfile[] {
    const rows = this.db.prepare(
      'SELECT * FROM wallet_profiles ORDER BY win_rate DESC LIMIT ?'
    ).all(limit) as any[];

    return rows.map(row => ({
      address: row.address,
      totalTrades: row.total_trades,
      winRate: row.win_rate,
      avgBetSize: row.avg_bet_size,
      profitLoss: row.profit_loss,
      streak: row.streak,
      lastActive: row.last_active,
      preferredAsset: row.preferred_asset,
      preferredDirection: row.preferred_direction,
      avgHoldTime: 300000,
      patterns: JSON.parse(row.patterns || '[]'),
    }));
  }

  // === SIGNAL PERFORMANCE ===

  saveSignalPerformance(type: string, wins: number, total: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO signal_performance (signal_type, wins, total, last_updated)
      VALUES (?, ?, ?, ?)
    `).run(type, wins, total, Date.now());
  }

  loadSignalPerformance(): Map<string, { wins: number; total: number }> {
    const rows = this.db.prepare('SELECT * FROM signal_performance').all() as any[];
    const map = new Map<string, { wins: number; total: number }>();
    for (const row of rows) {
      map.set(row.signal_type, { wins: row.wins, total: row.total });
    }
    return map;
  }

  // === BOT RUNS ===

  startRun(): number {
    const result = this.db.prepare(
      'INSERT INTO bot_runs (start_time) VALUES (?)'
    ).run(Date.now());
    return Number(result.lastInsertRowid);
  }

  endRun(runId: number, trades: number, profit: number, walletsScanned: number): void {
    this.db.prepare(`
      UPDATE bot_runs SET end_time = ?, trades_executed = ?, profit_loss = ?, wallets_scanned = ?
      WHERE id = ?
    `).run(Date.now(), trades, profit, walletsScanned, runId);
  }

  close(): void {
    this.db.close();
  }
}
