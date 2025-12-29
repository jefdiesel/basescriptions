# Basescriptions

Ethscriptions platform on Base L2. On-chain inscriptions for names, data, and websites.

## Protocol

Ethscriptions use transaction calldata for permanent on-chain storage:

- **Create**: Self-transfer (`to === from`) with `data:` prefixed UTF-8 calldata
- **ID**: SHA-256 hash of calldata (lowercase)
- **Transfer**: Send TX to recipient with inscription hash as calldata

```
data:,name                          # Plain text name
data:image/png;base64,iVBORw...     # Base64 image
data:text/html;base64,PCFET...      # Base64 HTML
data:application/json,{"key":...}   # JSON data
```

## Architecture

```
Base Chain (calldata) → Indexer → Supabase (metadata only)
                                        ↓
                                  API Worker → Frontend
                                        ↓
                              Subdomain Worker (*.basescriptions.com)
```

**Key design**: Database stores metadata only, NOT content. Content fetched from chain via RPC.

## Components

| Directory | Purpose | Deploy |
|-----------|---------|--------|
| `frontend/` | Static site | `npx wrangler pages deploy . --project-name=basescriptions --commit-dirty=true` |
| `worker/` | REST API (Hono) | `npx wrangler deploy` |
| `subdomain-worker/` | *.basescriptions.com | `npx wrangler deploy` |
| `scripts/` | Indexer, registration tools | `npx tsx script.ts` |

## API Endpoints

Base URL: `https://basescriptions-api.wrapit.workers.dev`

```
GET /content/:id          # Raw content (tx hash or content hash)
GET /name/:name           # Check name availability
GET /hash/:hash           # Inscription metadata
GET /recent               # Recent inscriptions (?limit=&offset=)
GET /owned/:address       # Owned by address
GET /stats                # Indexer stats
GET /marketplace/listings # Active listings
POST /register            # Register inscription
POST /transfer            # Record transfer
```

## Database (Supabase)

**base_ethscriptions**
- `id` (text, PK) - SHA-256 hash
- `content_uri` (text) - NULL (content on chain)
- `content_type` (text) - MIME type
- `creator`, `current_owner` (text) - Addresses
- `creation_tx` (text) - TX hash for content fetch
- `creation_block` (bigint)
- `inscription_number` (int)

**base_transfers** - Transfer history
**indexer_state** - Last indexed block
**marketplace_*** - Listings, offers, sales

## Content Fetching

Content lives on-chain. To fetch:

```javascript
// 1. Get TX from RPC
const tx = await fetch('https://mainnet.base.org', {
  method: 'POST',
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'eth_getTransactionByHash',
    params: [txHash]
  })
}).then(r => r.json());

// 2. Decode hex calldata
const hex = tx.result.input.slice(2);
const bytes = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
const content = new TextDecoder().decode(bytes);
// => "data:text/html;base64,..."
```

Or use API: `GET /content/:id` handles this automatically.

## Common Tasks

### Deploy frontend
```bash
cd frontend && npx wrangler pages deploy . --project-name=basescriptions --commit-dirty=true
```

### Deploy API
```bash
cd worker && npx wrangler deploy
```

### Run indexer
```bash
npx tsx scripts/backfill.ts
START_BLOCK=40000000 npx tsx scripts/backfill.ts
```

### Check indexer status
```bash
curl https://basescriptions-api.wrapit.workers.dev/stats
```

### Check Mac Mini indexer
```bash
SSHPASS='Margot25' sshpass -e ssh minim4@192.168.6.45 "tail -30 ~/basescriptions/logs/backfill.log"
SSHPASS='Margot25' sshpass -e ssh minim4@192.168.6.45 "launchctl list | grep base"
```

### Restart Mac Mini indexer
```bash
SSHPASS='Margot25' sshpass -e ssh minim4@192.168.6.45 "launchctl stop com.basescriptions.backfill && launchctl start com.basescriptions.backfill"
```

### Deploy script to Mac Mini
```bash
SSHPASS='Margot25' sshpass -e scp scripts/backfill.ts minim4@192.168.6.45:~/basescriptions/scripts/
```

### Insert missing inscription
```bash
npx tsx scripts/insert-missing.ts
```

## Environment Variables

```env
BASE_RPC_URL=https://mainnet.base.org
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
PRIVATE_KEY=0x...  # For registration scripts
```

## Frontend Pages

- `/` - Homepage, search, recent inscriptions
- `/item/:hash` - Inscription detail
- `/:address` - Wallet profile (if 0x...)
- `/:name` - Name profile (if not 0x)
- `/register/` - Register name
- `/inscribe/` - Inscribe data
- `/upload/` - Upload website
- `/marketplace/` - Buy/sell

## Subdomain Sites

1. User registers `mysite` name
2. User creates manifest: `{"basescriptions":{"mysite":{"home":"0xtx..."}}}`
3. User inscribes HTML content
4. `mysite.basescriptions.com` serves the HTML

Subdomain worker flow:
1. Extract subdomain from host
2. Find owner via `/name/:name` API
3. Find manifest in owner's inscriptions
4. Fetch HTML from chain via `creation_tx`
5. Serve with injected base tag

## RPC Endpoints

```
https://mainnet.base.org              # Primary (rate limited)
https://base-mainnet.g.alchemy.com    # Fallback
https://base.llamarpc.com             # Fallback
https://base-rpc.publicnode.com       # Fallback
```

## Indexer Notes

- Uses `staticNetwork: true` in ethers.js to skip network detection (prevents blocking when RPC is down)
- Automatic RPC fallback when rate limited or failing
- Saves progress to `indexer_state` table every batch
- Runs as launchd service on Mac Mini with KeepAlive

## Frontend Notes

- Chain verification before every transaction (prevents wrong-chain sends)
- Filters `application/json` and `application/text` spam from recent display
- HTML iframes get injected CSS for transparent backgrounds
- Infinite scroll with lazy loading for recent inscriptions

## Notes

- Chain: Base L2, chainId 8453 (hex: 0x2105)
- Gas: ~$0.001 per inscription
- Content must be valid UTF-8 with `data:` prefix
- Large content (>2.7KB) was causing DB index issues - now content_uri is NULL
- Inscription numbers are sequential per indexer
- Transfers require sender to currently own the inscription
