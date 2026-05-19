# 🎯 POLYMARKINGS

**Auto Trading Bot untuk Polymarket Up/Down 5m Markets**

Bot trading otomatis yang menggunakan Kelly Criterion, wallet scanning 14.000 dompet, dan pattern detection untuk menemukan edge di market Up/Down 5 menit pada BTC, ETH, SOL, dan XRP.

---

## ⚡ Fitur Utama

| Fitur | Deskripsi |
|-------|-----------|
| **Kelly Criterion** | Position sizing adaptif yang semakin pintar seiring waktu |
| **14K Wallet Scanner** | Memindai 14.000 dompet dalam hitungan menit |
| **Pattern Detection** | Mendeteksi pola-pola pemenang dari smart wallets |
| **Mispricing Engine** | Melihat kesalahan harga vs fair value |
| **VPS Mode** | Berjalan 24/7, semakin lama semakin pintar |
| **$5 → $2,000** | Compound growth dengan risk management ketat |

---

## 🏗️ Arsitektur

```
┌─────────────────────────────────────────────────┐
│                 POLYMARKINGS                      │
├─────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  Wallet  │  │ Pattern  │  │  Mispricing   │  │
│  │ Scanner  │──│ Detector │──│   Engine      │  │
│  │ (14,000) │  │          │  │              │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
│        │              │              │           │
│        └──────────────┼──────────────┘           │
│                       ▼                          │
│              ┌────────────────┐                  │
│              │  Signal Combiner│                  │
│              │  (5 signal types)│                 │
│              └────────────────┘                  │
│                       │                          │
│                       ▼                          │
│              ┌────────────────┐                  │
│              │ Kelly Criterion │                  │
│              │ (adaptive sizing)│                 │
│              └────────────────┘                  │
│                       │                          │
│                       ▼                          │
│              ┌────────────────┐                  │
│              │ Trade Executor  │                  │
│              │ (Polymarket API)│                  │
│              └────────────────┘                  │
│                       │                          │
│                       ▼                          │
│              ┌────────────────┐                  │
│              │   Database     │                  │
│              │  (learning)    │                  │
│              └────────────────┘                  │
│                                                  │
└─────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your Polymarket wallet private key
```

### 3. Run Backtest (Test Strategy)

```bash
npm run backtest
```

### 4. Run Wallet Scanner (Standalone)

```bash
npm run scan
```

### 5. Start Trading Bot

```bash
npm run build
npm start
```

### Development Mode

```bash
npm run dev
```

---

## 📊 Cara Kerja

### 1. Wallet Scanner (14,000 Dompet)
- Fetch semua trader aktif dari Polymarket Up/Down 5m
- Profile setiap wallet: win rate, pola ukuran bet, aset favorit
- Ranking berdasarkan composite score
- Cross-reference tingkat kemenangan dan pola ukuran

### 2. Pattern Detection (5 Signal Types)
1. **Wallet Consensus** - Apa yang dilakukan top wallets?
2. **Mispricing** - Market price vs fair value dari smart money
3. **Size Patterns** - Big money masuk di arah mana?
4. **Momentum** - Trade terakhir mengarah kemana?
5. **Contrarian** - Smart wallets melawan market?

### 3. Kelly Criterion (Adaptive)
- Menghitung ukuran bet optimal berdasarkan edge
- Quarter Kelly default (lebih aman)
- Anti-tilt: reduce sizing setelah loss berturut-turut
- Drawdown protection: reduce saat mendekati max drawdown
- **Semakin banyak trading → semakin akurat kalkulasi**

### 4. Trade Execution
- Place order di Polymarket CLOB API
- Fill or Kill (FOK) untuk eksekusi cepat
- Max 5 posisi terbuka bersamaan
- 30 detik cooldown antar trade
- Auto-resolve saat market 5m expired

---

## ⚙️ Konfigurasi

| Parameter | Default | Deskripsi |
|-----------|---------|-----------|
| `INITIAL_BANKROLL` | $5 | Modal awal |
| `KELLY_FRACTION` | 0.25 | 25% dari full Kelly (quarter kelly) |
| `MIN_EDGE` | 0.03 | Minimum 3% edge untuk trade |
| `MIN_CONFIDENCE` | 0.55 | Minimum 55% confidence |
| `MAX_BET_FRACTION` | 0.15 | Max 15% bankroll per trade |
| `MAX_DRAWDOWN_PCT` | 0.50 | Stop jika drawdown 50% |
| `SCANNER_TARGET_WALLETS` | 14000 | Jumlah dompet yang dipindai |
| `SCANNER_REFRESH_INTERVAL` | 5 min | Refresh wallet data setiap 5 menit |

---

## 🖥️ VPS Mode (24/7)

Untuk menjalankan di VPS (semakin lama jalan, semakin pintar):

```bash
# Build
npm run build

# Run with PM2 (recommended)
pm2 start dist/index.js --name polymarkings

# View logs
pm2 logs polymarkings

# Monitor
pm2 monit
```

Atau dengan `systemd`:

```ini
[Unit]
Description=Polymarkings Trading Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/polymarkings
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

---

## 📈 Learning System

Bot semakin pintar seiring waktu:

1. **Kelly Adaptation** - Win rate dan multiplier menyesuaikan dari trading history
2. **Signal Calibration** - Track akurasi setiap tipe signal, adjust confidence
3. **Wallet Ranking** - Re-scan dan update ranking setiap 5 menit
4. **Pattern Performance** - Record signal mana yang paling profitable
5. **Database Persistence** - Semua state disimpan, bot bisa restart tanpa kehilangan knowledge

---

## ⚠️ Risk Management

- **Quarter Kelly** - Hanya bet 25% dari optimal Kelly (mengurangi variance)
- **Max Drawdown** - Auto-stop jika loss 50% dari peak
- **Anti-Tilt** - Reduce bet size setelah 3+ consecutive losses
- **Position Limits** - Max 5 posisi terbuka
- **Cooldown** - 30 detik minimum antar trade
- **Edge Requirement** - Hanya trade jika edge ≥ 3%

---

## 📁 Project Structure

```
polymarkings/
├── src/
│   ├── index.ts              # Main bot orchestrator
│   ├── types/index.ts        # TypeScript type definitions
│   ├── config/
│   │   ├── index.ts          # Configuration management
│   │   └── logger.ts         # Winston logger setup
│   ├── kelly/
│   │   └── kelly-engine.ts   # Kelly Criterion engine
│   ├── scanner/
│   │   ├── wallet-scanner.ts # 14K wallet scanner
│   │   └── run-scan.ts       # Standalone scanner
│   ├── patterns/
│   │   └── pattern-engine.ts # Pattern detection & mispricing
│   ├── trading/
│   │   ├── polymarket-client.ts # Polymarket API client
│   │   └── trade-executor.ts    # Trade execution
│   ├── storage/
│   │   └── database.ts       # SQLite persistence
│   └── backtest/
│       └── run-backtest.ts   # Backtest simulation
├── data/                     # Database files (gitignored)
├── logs/                     # Log files (gitignored)
├── .env.example              # Environment template
├── package.json
├── tsconfig.json
└── README.md
```

---

## 📄 License

MIT

---

**Disclaimer:** Bot ini untuk tujuan edukasi. Trading memiliki risiko kehilangan modal. Gunakan dengan bijak dan hanya dana yang siap Anda kehilangan.
