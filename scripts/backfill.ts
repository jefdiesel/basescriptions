import { createClient } from '@supabase/supabase-js'
import { ethers, JsonRpcProvider } from 'ethers'
import { createHash } from 'crypto'
import 'dotenv/config'

// Multiple RPC endpoints with fallback
const RPC_URLS = [
  process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  'https://base-mainnet.g.alchemy.com/v2/YDk7TKMgutp260sJNRhkH',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
]

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

let currentRpcIndex = 0
let provider = new JsonRpcProvider(RPC_URLS[currentRpcIndex])
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

function switchProvider(): JsonRpcProvider {
  currentRpcIndex = (currentRpcIndex + 1) % RPC_URLS.length
  console.log(`Switching to RPC: ${RPC_URLS[currentRpcIndex]}`)
  provider = new JsonRpcProvider(RPC_URLS[currentRpcIndex])
  return provider
}

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '10')
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '1')

async function getStartBlock(): Promise<number> {
  if (process.env.START_BLOCK) {
    return parseInt(process.env.START_BLOCK)
  }
  const { data } = await supabase
    .from('indexer_state')
    .select('value')
    .eq('key', 'base_ethscriptions')
    .single()

  if (data?.value) {
    const lastBlock = parseInt(data.value)
    console.log(`Resuming from saved position: block ${lastBlock}`)
    return lastBlock
  }
  return 0
}

function hexToUtf8(hex: string): string | null {
  try {
    if (!hex || hex === '0x') return null
    const bytes = ethers.getBytes(hex)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function sha256(content: string): string {
  return '0x' + createHash('sha256').update(content).digest('hex')
}

async function getBlockWithRetry(blockNum: number, retries = 3): Promise<any> {
  // Try each RPC provider
  for (let providerAttempt = 0; providerAttempt < RPC_URLS.length; providerAttempt++) {
    for (let i = 0; i < retries; i++) {
      try {
        const block = await provider.getBlock(blockNum, true)
        if (block && block.prefetchedTransactions) {
          return block
        }
        // Block exists but no transactions - that's valid
        if (block && block.transactions?.length === 0) {
          return block
        }
        console.log(`Block ${blockNum}: empty response, retry ${i + 1}/${retries}`)
      } catch (e: any) {
        const isRateLimit = e.message?.includes('429') || e.code === 429 || e.error?.code === 429
        if (isRateLimit) {
          console.log(`Block ${blockNum}: rate limited on ${RPC_URLS[currentRpcIndex]}, switching provider`)
          switchProvider()
          break // Try next provider immediately
        }
        console.log(`Block ${blockNum}: error ${e.message?.slice(0, 50)}, retry ${i + 1}/${retries}`)
      }
      await new Promise(r => setTimeout(r, 500 * (i + 1)))
    }
    // If we exhausted retries on this provider, try next one
    if (providerAttempt < RPC_URLS.length - 1) {
      switchProvider()
    }
  }
  return null
}

async function processBlock(blockNum: number): Promise<{ created: number; transferred: number }> {
  let created = 0
  let transferred = 0

  const block = await getBlockWithRetry(blockNum)
  if (!block) {
    console.log(`Block ${blockNum}: FAILED after retries`)
    return { created: 0, transferred: 0 }
  }

  const txs = block.prefetchedTransactions || []
  const timestamp = new Date(block.timestamp * 1000).toISOString()

  for (const tx of txs) {
    if (!tx.to) continue

    const from = tx.from.toLowerCase()
    const to = tx.to.toLowerCase()

    if (from === to) {
      const content = hexToUtf8(tx.data)
      if (!content || !content.startsWith('data:')) continue

      const hash = sha256(content)

      // Extract content type
      let contentType = 'text/plain'
      const match = content.match(/^data:([^,;]+)/)
      if (match && match[1]) {
        contentType = match[1]
      }

      const { data: existing } = await supabase
        .from('base_ethscriptions')
        .select('id')
        .eq('id', hash)
        .single()

      if (!existing) {
        const { error } = await supabase.from('base_ethscriptions').insert({
          id: hash,
          content_uri: content,
          content_type: contentType,
          creator: from,
          current_owner: from,
          creation_tx: tx.hash,
          creation_block: blockNum,
          creation_timestamp: timestamp
        })
        if (error) {
          console.log(`Insert error for ${content.slice(0, 30)}: ${error.message}`)
        } else {
          console.log(`NEW: ${content.slice(0, 50)} in block ${blockNum}`)
          created++
        }
      }
    } else if (tx.data.length === 66) {
      const hash = tx.data.toLowerCase()

      const { data: ethscription } = await supabase
        .from('base_ethscriptions')
        .select('id')
        .eq('id', hash)
        .eq('current_owner', from)
        .single()

      if (ethscription) {
        await supabase
          .from('base_ethscriptions')
          .update({ current_owner: to })
          .eq('id', hash)

        await supabase.from('base_transfers').insert({
          ethscription_id: hash,
          from_address: from,
          to_address: to,
          tx_hash: tx.hash,
          block_number: blockNum,
          timestamp
        })
        transferred++
      }
    }
  }

  return { created, transferred }
}

async function getBlockNumberWithFallback(): Promise<number> {
  for (let i = 0; i < RPC_URLS.length; i++) {
    try {
      return await provider.getBlockNumber()
    } catch (e: any) {
      console.log(`Failed to get block number from ${RPC_URLS[currentRpcIndex]}: ${e.message?.slice(0, 50)}`)
      switchProvider()
    }
  }
  throw new Error('All RPC providers failed')
}

async function main() {
  console.log('Base Ethscriptions Backfill')
  console.log('===========================')
  console.log(`Primary RPC: ${RPC_URLS[0]}`)
  console.log(`Fallback RPCs: ${RPC_URLS.slice(1).join(', ')}\n`)

  const currentBlock = await getBlockNumberWithFallback()
  const startBlock = await getStartBlock()

  console.log(`Current block: ${currentBlock}`)
  console.log(`Starting from: ${startBlock}`)
  console.log(`Batch size: ${BATCH_SIZE}`)
  console.log(`Concurrency: ${CONCURRENCY}\n`)

  let processed = startBlock
  let totalCreated = 0
  let totalTransferred = 0
  const startTime = Date.now()

  while (processed < currentBlock) {
    const batchEnd = Math.min(processed + BATCH_SIZE, currentBlock)
    const blockNums = Array.from({ length: batchEnd - processed }, (_, i) => processed + i)

    // Process blocks sequentially with delay to avoid rate limiting
    const results: { created: number; transferred: number }[] = []
    for (const blockNum of blockNums) {
      const result = await processBlock(blockNum)
      results.push(result)
      await new Promise(r => setTimeout(r, 200)) // 200ms delay between blocks
    }

    for (const r of results) {
      totalCreated += r.created
      totalTransferred += r.transferred
    }

    processed = batchEnd

    const elapsed = (Date.now() - startTime) / 1000
    const blocksPerSec = (processed - startBlock) / elapsed
    const remaining = (currentBlock - processed) / blocksPerSec

    process.stdout.write(
      `\rBlock ${processed.toLocaleString()} / ${currentBlock.toLocaleString()} ` +
      `(${((processed / currentBlock) * 100).toFixed(2)}%) ` +
      `| ${blocksPerSec.toFixed(0)} blk/s ` +
      `| ETA: ${Math.floor(remaining / 60)}m ` +
      `| Found: ${totalCreated} created, ${totalTransferred} transferred`
    )

    // Save progress every batch
    await supabase
      .from('indexer_state')
      .upsert({ key: 'base_ethscriptions', value: processed.toString(), updated_at: new Date().toISOString() })
  }

  console.log('\n\nBackfill complete!')
  console.log(`Total: ${totalCreated} ethscriptions, ${totalTransferred} transfers`)
}

main().catch(console.error)
