import { createClient } from '@supabase/supabase-js'
import { ethers, JsonRpcProvider } from 'ethers'
import { createHash } from 'crypto'
import 'dotenv/config'

const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

const provider = new JsonRpcProvider(BASE_RPC)
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100')
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5')

async function getStartBlock(): Promise<number> {
  // Check env var first
  if (process.env.START_BLOCK) {
    return parseInt(process.env.START_BLOCK)
  }
  // Otherwise, read from database
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

async function processBlockBatch(startBlock: number, count: number): Promise<{
  blocks: number
  created: number
  transferred: number
}> {
  let created = 0
  let transferred = 0

  const promises = Array.from({ length: count }, (_, i) =>
    provider.getBlock(startBlock + i, true).catch(() => null)
  )

  const blocks = await Promise.all(promises)

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block || !block.prefetchedTransactions) continue

    const blockNum = startBlock + i
    const timestamp = new Date(block.timestamp * 1000).toISOString()

    for (const tx of block.prefetchedTransactions) {
      if (!tx.to) continue

      const from = tx.from.toLowerCase()
      const to = tx.to.toLowerCase()

      if (from === to) {
        const content = hexToUtf8(tx.data)
        if (!content || !content.startsWith('data:')) continue

        const hash = sha256(content)

        // Extract content type from data URI
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
          await supabase.from('base_ethscriptions').insert({
            id: hash,
            content_uri: content,
            content_type: contentType,
            creator: from,
            current_owner: from,
            creation_tx: tx.hash,
            creation_block: blockNum,
            creation_timestamp: timestamp
          })
          created++
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
  }

  return { blocks: count, created, transferred }
}

async function main() {
  console.log('Base Ethscriptions Backfill')
  console.log('===========================\n')

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
    const batches: Promise<any>[] = []

    for (let i = 0; i < CONCURRENCY && processed + i * BATCH_SIZE < currentBlock; i++) {
      const start = processed + i * BATCH_SIZE
      const count = Math.min(BATCH_SIZE, currentBlock - start)
      batches.push(processBlockBatch(start, count))
    }

    const results = await Promise.all(batches)

    for (const r of results) {
      processed += r.blocks
      totalCreated += r.created
      totalTransferred += r.transferred
    }

    const elapsed = (Date.now() - startTime) / 1000
    const blocksPerSec = processed / elapsed
    const remaining = (currentBlock - processed) / blocksPerSec

    console.log(
      `Block ${processed.toLocaleString()} / ${currentBlock.toLocaleString()} ` +
      `(${((processed / currentBlock) * 100).toFixed(2)}%) ` +
      `| ${blocksPerSec.toFixed(0)} blk/s ` +
      `| ETA: ${Math.floor(remaining / 60)}m ` +
      `| Found: ${totalCreated} created, ${totalTransferred} transferred`
    )

    // Save progress
    await supabase
      .from('indexer_state')
      .upsert({ key: 'base_ethscriptions', value: processed.toString(), updated_at: new Date().toISOString() })
  }

  console.log('\n\nBackfill complete!')
  console.log(`Total: ${totalCreated} ethscriptions, ${totalTransferred} transfers`)
}

main().catch(console.error)
