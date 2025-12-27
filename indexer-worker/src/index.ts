interface Env {
  BASE_RPC: string;
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
}

interface Block {
  number: string;
  transactions: Transaction[];
}

interface Transaction {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  blockNumber: string;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(indexBlocks(env));
  },

  async fetch(request: Request, env: Env) {
    // Manual trigger endpoint
    if (new URL(request.url).pathname === '/run') {
      await indexBlocks(env);
      return new Response('Indexer ran successfully');
    }
    return new Response('Basescriptions Indexer. Use /run to trigger manually.');
  }
};

async function indexBlocks(env: Env) {
  const BATCH_SIZE = 100; // Process 100 blocks per run (need 30+/min to keep up with Base)

  // Get last indexed block from Supabase
  const stateRes = await fetch(`${env.SUPABASE_URL}/rest/v1/indexer_state?key=eq.base_ethscriptions`, {
    headers: {
      'apikey': env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`
    }
  });

  const stateData = await stateRes.json() as any[];
  let lastBlock = parseInt(stateData[0]?.value || '0');

  // Get current block number
  const currentBlockHex = await rpcCall(env.BASE_RPC, 'eth_blockNumber', []);
  const currentBlock = parseInt(currentBlockHex, 16);

  if (lastBlock >= currentBlock) {
    console.log('Already up to date');
    return;
  }

  const startBlock = lastBlock + 1;
  const endBlock = Math.min(startBlock + BATCH_SIZE - 1, currentBlock);

  console.log(`Indexing blocks ${startBlock} to ${endBlock}`);

  const ethscriptions: any[] = [];

  // Process blocks - use batch RPC call
  const batchRequests = [];
  for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
    batchRequests.push({
      jsonrpc: '2.0',
      id: blockNum,
      method: 'eth_getBlockByNumber',
      params: ['0x' + blockNum.toString(16), true]
    });
  }

  const batchRes = await fetch(env.BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batchRequests)
  });
  const blocks = await batchRes.json() as any[];

  for (const blockData of blocks) {
    const block = blockData.result as Block;
    if (!block || !block.transactions) continue;
    const blockNum = parseInt(block.number, 16);

    for (const tx of block.transactions) {
      // Must be self-transfer with data
      if (!tx.to || tx.from.toLowerCase() !== tx.to.toLowerCase()) continue;
      if (!tx.input || tx.input === '0x' || tx.input.length < 10) continue;

      const content = hexToString(tx.input);
      if (!content.startsWith('data:')) continue;

      const hash = await sha256(tx.input.toLowerCase());

      // Insert with conflict handling - Supabase will ignore duplicates
      ethscriptions.push({
        id: hash,
        creator: tx.from.toLowerCase(),
        current_owner: tx.from.toLowerCase(),
        creation_tx: tx.hash.toLowerCase(),
        creation_block: blockNum,
        creation_timestamp: new Date().toISOString(),
        content_uri: content.slice(0, 1000),
        content_type: getContentType(content)
      });
    }
  }

  // Batch insert ethscriptions (ignore duplicates via conflict handling)
  if (ethscriptions.length > 0) {
    const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/base_ethscriptions`, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates'
      },
      body: JSON.stringify(ethscriptions)
    });
    console.log(`Processed ${ethscriptions.length} ethscriptions (status: ${insertRes.status})`);
  }

  // Update last indexed block
  await fetch(`${env.SUPABASE_URL}/rest/v1/indexer_state?key=eq.base_ethscriptions`, {
    method: 'PATCH',
    headers: {
      'apikey': env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ value: String(endBlock), updated_at: new Date().toISOString() })
  });

  console.log(`Updated to block ${endBlock}`);
}

async function rpcCall(url: string, method: string, params: any[]) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const data = await res.json() as { result: any };
  return data.result;
}

function hexToString(hex: string): string {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  let str = '';
  for (let i = 0; i < cleanHex.length; i += 2) {
    str += String.fromCharCode(parseInt(cleanHex.substr(i, 2), 16));
  }
  return str;
}

function getContentType(content: string): string {
  const match = content.match(/^data:([^;,]+)/);
  return match ? match[1] : 'text/plain';
}

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
