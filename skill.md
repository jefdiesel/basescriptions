# Basescriptions

Ethscriptions indexer for Base L2. First-mover implementation of the ethscriptions protocol on Base.

## Protocol

Ethscriptions are onchain data inscriptions using transaction calldata:

1. **Creation**: Self-transfer (`to === from`) with `data:,` prefixed UTF-8 calldata
2. **Identity**: SHA256 hash of the full content (e.g., `sha256("data:,hello")`)
3. **Ownership**: First valid inscription of a hash = creator/owner
4. **Transfer**: TX to another address with the ethscription hash as calldata

## Architecture

```
Base RPC → Indexer (Node.js) → Supabase (PostgreSQL)
                                      ↓
                               API (future)
```

## Project Structure

```
basescriptions/
├── scripts/
│   ├── indexer.ts      # Real-time block indexer
│   ├── backfill.ts     # Historical sync from genesis
│   └── register.ts     # CLI to register names
├── supabase/
│   └── migrations/
│       └── 001_base_ethscriptions.sql
└── src/                # Future API code
```

## Setup

1. Create Supabase project, run migration in `supabase/migrations/`
2. Copy `.env.example` to `.env` and fill in values
3. `npm install`
4. Run indexer: `npm run index`

## Commands

- `npm run index` - Start real-time indexer
- `npm run backfill` - Sync from genesis (env: START_BLOCK, BATCH_SIZE, CONCURRENCY)
- `npm run register name1 name2` - Register ethscriptions

## Database Tables

- `base_ethscriptions` - All inscriptions (id=sha256 hash, content_uri, creator, current_owner)
- `base_transfers` - Transfer history
- `indexer_state` - Last indexed block

## Notes

- Base mainnet started at block 0 (June 2023)
- Gas is ~$0.001 per inscription
- Content must be valid UTF-8 starting with `data:,`
- Transfers require sender to own the ethscription
