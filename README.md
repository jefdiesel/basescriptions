# Basescriptions

Inscriptions on Base L2. Register names and data for ~$0.001 per inscription.

## Live Site
https://basescriptions.com

## Components

- **frontend/** - Static site hosted on Cloudflare Pages
- **worker/** - API worker on Cloudflare Workers
- **indexer-worker/** - Cron-based indexer for new blocks
- **scripts/** - Backfill and batch registration scripts

## API Endpoints

```
GET /recent?limit=24&offset=0  - Recent inscriptions
GET /stats                      - Total counts
GET /hash/{sha256}              - Lookup by content hash
GET /name/{name}                - Check name availability
GET /owned/{address}            - Inscriptions owned by address
GET /created/{address}          - Inscriptions created by address
```

## Running the Indexer

### One-time backfill
```bash
cd /Users/jef/basescriptions
npx tsx scripts/backfill.ts
```

### Start from specific block
```bash
START_BLOCK=15000000 npx tsx scripts/backfill.ts
```

### Run as persistent service (Mac)
```bash
# Copy launchd plist
cp scripts/com.basescriptions.backfill.plist ~/Library/LaunchAgents/

# Load service
launchctl load ~/Library/LaunchAgents/com.basescriptions.backfill.plist

# Check status
launchctl list | grep basescriptions

# View logs
tail -f logs/backfill.log
```

## Batch Registration

Register names from the predefined list (a-z, aa-zz, 0-1111):

```bash
# Start from beginning
npx tsx scripts/batch-register.ts

# Continue from specific index
START_INDEX=500 npx tsx scripts/batch-register.ts
```

## Deploy

```bash
# Frontend
cd frontend && npx wrangler pages deploy .

# API Worker
cd worker && npx wrangler deploy

# Indexer Worker
cd indexer-worker && npx wrangler deploy
```
