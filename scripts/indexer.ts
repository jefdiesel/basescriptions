import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { ethers, JsonRpcProvider, Block, TransactionResponse } from 'ethers'
import { createHash } from 'crypto'
import 'dotenv/config'

const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

const provider = new JsonRpcProvider(BASE_RPC)
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Convert hex calldata to UTF-8 string
function hexToUtf8(hex: string): string | null {
  try {
    if (!hex || hex === '0x') return null
    const bytes = ethers.getBytes(hex)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text
  } catch {
    return null // Not valid UTF-8
  }
}

// Compute SHA256 hash of content
function sha256(content: string): string {
  return '0x' + createHash('sha256').update(content).digest('hex')
}

// Check if content is valid ethscription format
function isValidEthscription(content: string): boolean {
  return content.startsWith('data:,')
}

// Get last indexed block from state
async function getLastBlock(): Promise<number> {
  const { data } = await supabase
    .from('indexer_state')
    .select('value')
    .eq('key', 'last_block')
    .single()

  return data ? parseInt(data.value) : 0
}

// Update last indexed block
async function setLastBlock(block: number): Promise<void> {
  await supabase
    .from('indexer_state')
    .upsert({ key: 'last_block', value: block.toString(), updated_at: new Date().toISOString() })
}

// Process a single block for ethscriptions
async function processBlock(blockNumber: number): Promise<{ created: number; transferred: number }> {
  const block = await provider.getBlock(blockNumber, true)
  if (!block || !block.prefetchedTransactions) {
    return { created: 0, transferred: 0 }
  }

  let created = 0
  let transferred = 0
  const timestamp = new Date(block.timestamp * 1000).toISOString()

  for (const tx of block.prefetchedTransactions) {
    if (!tx.to) continue // Skip contract creations

    const from = tx.from.toLowerCase()
    const to = tx.to.toLowerCase()

    // CREATION: Self-transfer with data:, prefix
    if (from === to) {
      const content = hexToUtf8(tx.data)
      if (!content || !isValidEthscription(content)) continue

      const hash = sha256(content)

      // Check if already exists
      const { data: existing } = await supabase
        .from('base_ethscriptions')
        .select('id')
        .eq('id', hash)
        .single()

      if (!existing) {
        const { error } = await supabase.from('base_ethscriptions').insert({
          id: hash,
          content_uri: content,
          content_type: 'text/plain',
          creator: from,
          current_owner: from,
          creation_tx: tx.hash,
          creation_block: blockNumber,
          creation_timestamp: timestamp
        })

        if (!error) {
          console.log(`  + Created: ${content.slice(0, 50)}... by ${from.slice(0, 10)}`)
          created++
        }
      }
    }
    // TRANSFER: Send to another address with hash as calldata
    else if (tx.data.length === 66) { // 0x + 64 hex = sha256 hash
      const hash = tx.data.toLowerCase()

      // Check if valid ethscription owned by sender
      const { data: ethscription } = await supabase
        .from('base_ethscriptions')
        .select('id, content_uri')
        .eq('id', hash)
        .eq('current_owner', from)
        .single()

      if (ethscription) {
        // Update owner
        await supabase
          .from('base_ethscriptions')
          .update({ current_owner: to })
          .eq('id', hash)

        // Record transfer
        await supabase.from('base_transfers').insert({
          ethscription_id: hash,
          from_address: from,
          to_address: to,
          tx_hash: tx.hash,
          block_number: blockNumber,
          timestamp
        })

        console.log(`  → Transfer: ${ethscription.content_uri.slice(0, 30)}... ${from.slice(0, 10)} → ${to.slice(0, 10)}`)
        transferred++
      }
    }
  }

  return { created, transferred }
}

// Main indexer loop
async function main() {
  console.log('Base Ethscriptions Indexer')
  console.log('==========================\n')

  let lastBlock = await getLastBlock()
  console.log(`Starting from block ${lastBlock}`)

  while (true) {
    try {
      const currentBlock = await provider.getBlockNumber()

      if (lastBlock >= currentBlock) {
        // Wait for new blocks
        await new Promise(r => setTimeout(r, 2000))
        continue
      }

      // Process blocks in batches
      const batchSize = Math.min(10, currentBlock - lastBlock)

      for (let i = 0; i < batchSize; i++) {
        const blockNum = lastBlock + 1 + i
        process.stdout.write(`\rBlock ${blockNum} / ${currentBlock}`)

        const stats = await processBlock(blockNum)
        if (stats.created || stats.transferred) {
          console.log(`\n  Block ${blockNum}: +${stats.created} created, ${stats.transferred} transferred`)
        }
      }

      lastBlock += batchSize
      await setLastBlock(lastBlock)

    } catch (error) {
      console.error('\nError:', error)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

main().catch(console.error)
