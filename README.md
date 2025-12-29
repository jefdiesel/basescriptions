# Basescriptions

Ethscriptions on Base L2. Register names, inscribe data, host websites - all on-chain for ~$0.001.

**Live:** https://basescriptions.com

---

## What are Ethscriptions?

On-chain data inscriptions using transaction calldata:

1. **Create** - Self-transfer (`to === from`) with `data:` prefixed UTF-8 calldata
2. **Identity** - SHA-256 hash of calldata = unique inscription ID
3. **Ownership** - First valid inscription of a hash = owner
4. **Transfer** - Send to another address with inscription hash as calldata

```
data:,jef                           → Name registration
data:image/png;base64,iVBORw0...    → Image inscription
data:text/html;base64,PCFET0N...    → HTML website
data:application/json,{...}         → JSON manifest
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Base L2 Chain                           │
│                    (content stored in calldata)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │   Backfill   │  │  API Worker  │  │  Subdomain   │
    │   Indexer    │  │    (Hono)    │  │   Worker     │
    │  (Node.js)   │  │              │  │              │
    └──────┬───────┘  └──────┬───────┘  └──────────────┘
           │                 │                 │
           ▼                 ▼                 │
    ┌─────────────────────────────┐            │
    │   Supabase (PostgreSQL)    │            │
    │   - base_ethscriptions     │            │
    │   - base_transfers         │            │
    │   - marketplace_*          │            │
    │   - indexer_state          │            │
    └─────────────────────────────┘            │
                    │                          │
                    ▼                          ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                    Cloudflare Pages                         │
    │                  basescriptions.com                         │
    │         *.basescriptions.com (subdomain sites)              │
    └─────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
basescriptions/
├── frontend/                 # Static site (Cloudflare Pages)
│   ├── index.html           # Homepage with search & recent inscriptions
│   ├── item/                # Inscription detail page
│   ├── address/             # Wallet/profile page
│   ├── register/            # Name registration
│   ├── inscribe/            # Data inscription tool
│   ├── upload/              # Website upload tool
│   ├── marketplace/         # Buy/sell marketplace
│   └── _worker.js           # Dynamic routing (addresses, names)
│
├── worker/                   # API (Cloudflare Workers)
│   └── src/index.ts         # Hono REST API
│
├── subdomain-worker/         # *.basescriptions.com handler
│   └── index.js             # Serves inscribed websites
│
├── scripts/                  # Node.js tools
│   ├── backfill.ts          # Historical block indexer
│   ├── indexer.ts           # Real-time indexer
│   ├── batch-register.ts    # Bulk name registration
│   ├── register.ts          # Single name registration
│   └── insert-missing.ts    # Manual inscription insert
│
└── supabase/
    └── migrations/          # Database schema
        ├── 001_base_ethscriptions.sql
        └── 002_remove_content_storage.sql
```

---

## Key Features

### Name Registration
Register unique names like `jef`, `hello`, `42` as ethscriptions.

### Data Inscription
Inscribe any data: images, HTML, JSON, text. Stored forever on Base.

### Website Hosting
Upload HTML sites that live at `yourname.basescriptions.com`.

### Marketplace
List, buy, sell, and make offers on inscriptions.

### Content Proxy
API serves raw content via `/content/:id` - no need to decode calldata yourself.

### Spam Filtering
Frontend filters out `application/json` and `application/text` spam from recent inscriptions display.

---

## API

**Base URL:** `https://basescriptions-api.wrapit.workers.dev`

| Endpoint | Description |
|----------|-------------|
| `GET /content/:id` | Raw content (by tx hash or content hash) |
| `GET /name/:name` | Check name availability |
| `GET /hash/:hash` | Get inscription metadata |
| `GET /recent` | Recent inscriptions (paginated) |
| `GET /owned/:address` | Inscriptions owned by address |
| `GET /stats` | Indexer statistics |
| `GET /marketplace/listings` | Active marketplace listings |

See [worker/README.md](worker/README.md) for full API documentation.

---

## Database

Content is **not stored in the database** - only metadata. Content lives on-chain and is fetched via RPC.

### Tables

**base_ethscriptions**
| Column | Type | Description |
|--------|------|-------------|
| id | text | SHA-256 hash (primary key) |
| content_uri | text | NULL (content fetched from chain) |
| content_type | text | MIME type |
| creator | text | Creator address |
| current_owner | text | Current owner address |
| creation_tx | text | Transaction hash |
| creation_block | bigint | Block number |
| inscription_number | int | Sequential number |

**base_transfers**
- Transfer history (from, to, tx_hash, block)

**indexer_state**
- Tracks last indexed block

**marketplace_***
- Listings, offers, sales tables

---

## Setup

### 1. Database

Create Supabase project and run migrations:

```sql
-- Run in SQL Editor
-- See supabase/migrations/001_base_ethscriptions.sql
-- See supabase/migrations/002_remove_content_storage.sql
```

### 2. Environment

```bash
cp .env.example .env
```

```env
BASE_RPC_URL=https://mainnet.base.org
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJhbG...
PRIVATE_KEY=0x...  # For registration scripts
```

### 3. Install

```bash
npm install
```

---

## Running

### Backfill Indexer

Sync historical blocks:

```bash
# From last checkpoint
npx tsx scripts/backfill.ts

# From specific block
START_BLOCK=40000000 npx tsx scripts/backfill.ts
```

The indexer uses multiple RPC endpoints with automatic fallback:
- Primary: `https://mainnet.base.org`
- Fallbacks: Alchemy, LlamaRPC, PublicNode

Uses `staticNetwork: true` to prevent blocking on network detection when primary RPC is down.

### As macOS Service

```bash
cp scripts/com.basescriptions.backfill.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.basescriptions.backfill.plist
tail -f logs/backfill.log
```

### Batch Registration

```bash
npx tsx scripts/batch-register.ts
START_INDEX=500 npx tsx scripts/batch-register.ts
```

---

## Deploy

### Frontend (Cloudflare Pages)

```bash
cd frontend
npx wrangler pages deploy . --project-name=basescriptions --commit-dirty=true
```

### API Worker

```bash
cd worker
npx wrangler deploy
```

### Subdomain Worker

```bash
cd subdomain-worker
npx wrangler deploy
```

---

## Content Flow

```
1. User creates inscription
   └── TX: to=from, data="data:text/html;base64,..."

2. Indexer picks it up
   └── Stores: { id: sha256(calldata), creation_tx, creator, ... }
   └── Does NOT store content (too large for DB index)

3. Frontend/API fetches content
   └── GET /content/:id
   └── Worker fetches TX from Base RPC
   └── Decodes hex calldata → data URI
   └── Returns raw content with Content-Type header
```

---

## Subdomain Websites

Users can host websites at `name.basescriptions.com`:

1. **Register name** - Inscribe `data:,mysite`
2. **Create manifest** - Inscribe JSON pointing to content:
   ```json
   {"basescriptions":{"mysite":{"home":"0xtxhash..."}}}
   ```
3. **Upload site** - Use `/upload` tool to inscribe HTML
4. **Access** - Visit `mysite.basescriptions.com`

The subdomain worker:
1. Extracts subdomain from request
2. Finds name owner via API
3. Looks up manifest for that owner
4. Fetches HTML content from chain
5. Serves it with injected base tag

---

## Chain Verification

All frontend pages verify the user is on Base (chainId 0x2105) before any transaction:
- Automatically prompts to switch networks
- Adds Base network if not configured
- Prevents accidental mainnet transactions

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Chain | Base L2 (chainId: 8453) |
| Frontend | Vanilla HTML/JS, Cloudflare Pages |
| API | Hono on Cloudflare Workers |
| Database | Supabase (PostgreSQL) |
| Indexer | Node.js + ethers.js |
| Content | On-chain calldata, fetched via RPC |

---

## RPC Endpoints

```
https://mainnet.base.org              # Primary (rate limited)
https://base-mainnet.g.alchemy.com    # Fallback
https://base.llamarpc.com             # Fallback
https://base-rpc.publicnode.com       # Fallback
```

---

## Links

- **Live Site:** https://basescriptions.com
- **API:** https://basescriptions-api.wrapit.workers.dev
- **Base RPC:** https://mainnet.base.org
- **BaseScan:** https://basescan.org
