import { createClient } from '@supabase/supabase-js'
import { ethers, JsonRpcProvider } from 'ethers'
import { createHash } from 'crypto'
import 'dotenv/config'

const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

const provider = new JsonRpcProvider(BASE_RPC)
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

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

async function getBlockWithRetry(blockNum: number, retries = 5): Promise<any> {
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
      if (e.message?.includes('429')) {
        // Rate limited - wait longer
        await new Promise(r => setTimeout(r, 2000 * (i + 1)))
      }
      console.log(`Block ${blockNum}: error, retry ${i + 1}/${retries}`)
    }
    await new Promise(r => setTimeout(r, 1000 * (i + 1)))
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

async function main() {
  console.log('Base Ethscriptions Backfill')
  console.log('===========================')
  console.log(`RPC: ${BASE_RPC}\n`)

  const currentBlock = await provider.getBlockNumber()
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
