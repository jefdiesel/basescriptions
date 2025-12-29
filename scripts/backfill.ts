import { createClient } from '@supabase/supabase-js'
import { ethers, JsonRpcProvider } from 'ethers'
import { createHash } from 'crypto'
import { gunzipSync } from 'zlib'
import 'dotenv/config'

// Multiple RPC endpoints with fallback
const RPC_URLS = [
  process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  'https://base-mainnet.infura.io/v3/c7ce83ade81b4395b802afe030eeb7f0',
  'https://base-mainnet.g.alchemy.com/v2/YDk7TKMgutp260sJNRhkH',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
]

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

let currentRpcIndex = 0
const baseNetwork = { name: 'base', chainId: 8453 }
let provider = new JsonRpcProvider(RPC_URLS[currentRpcIndex], baseNetwork, { staticNetwork: true })
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ESIP-1: Smart Contract Transfer Event
const ESIP1_TOPIC = ethers.id('ethscriptions_protocol_TransferEthscription(address,bytes32)')
// ESIP-2: Safe Escrow Transfer Event
const ESIP2_TOPIC = ethers.id('ethscriptions_protocol_TransferEthscriptionForPreviousOwner(address,address,bytes32)')
// ESIP-3: Smart Contract Creation Event
const ESIP3_TOPIC = ethers.id('ethscriptions_protocol_CreateEthscription(address,string)')

function switchProvider(): JsonRpcProvider {
  currentRpcIndex = (currentRpcIndex + 1) % RPC_URLS.length
  console.log(`Switching to RPC: ${RPC_URLS[currentRpcIndex]}`)
  provider = new JsonRpcProvider(RPC_URLS[currentRpcIndex], baseNetwork, { staticNetwork: true })
  return provider
}

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '20')

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

// ESIP-7: Gzip decompression support
function decodeGzipContent(dataUri: string): string {
  try {
    // Check for gzip encoding in data URI
    // Format: data:mimetype;gzip;base64,... or data:mimetype;base64;gzip,...
    const gzipMatch = dataUri.match(/^data:([^;,]*)(;[^,]*)?,(.*)/s)
    if (!gzipMatch) return dataUri

    const [, mimeType, params, data] = gzipMatch
    if (!params?.includes('gzip')) return dataUri

    // Decode base64 and decompress
    const isBase64 = params.includes('base64')
    if (isBase64) {
      const compressed = Buffer.from(data, 'base64')
      const decompressed = gunzipSync(compressed)
      // Return decompressed data URI without gzip param
      const newParams = params.replace(';gzip', '').replace('gzip;', '')
      return `data:${mimeType}${newParams},${decompressed.toString('base64')}`
    }
    return dataUri
  } catch (e) {
    // If decompression fails, return original
    return dataUri
  }
}

// ESIP-6: Check for non-uniqueness opt-in
function hasEsip6Rule(content: string): boolean {
  // Check for rule=esip6 in data URI parameters
  // Format: data:mimetype;rule=esip6,... or in query params
  return content.includes('rule=esip6')
}

// Parse protocol handler JSON from content
function parseProtocolJson(content: string): any | null {
  try {
    if (!content.startsWith('data:application/json')) return null
    const jsonMatch = content.match(/^data:application\/json[^,]*,(.*)$/s)
    if (!jsonMatch) return null

    let jsonStr = jsonMatch[1]
    // Handle base64 encoding
    if (content.includes(';base64,')) {
      jsonStr = Buffer.from(jsonStr, 'base64').toString('utf-8')
    } else {
      jsonStr = decodeURIComponent(jsonStr)
    }

    return JSON.parse(jsonStr)
  } catch {
    return null
  }
}

async function getBlockWithRetry(blockNum: number, retries = 3): Promise<any> {
  for (let providerAttempt = 0; providerAttempt < RPC_URLS.length; providerAttempt++) {
    for (let i = 0; i < retries; i++) {
      try {
        const block = await provider.getBlock(blockNum, true)
        if (block && block.prefetchedTransactions) {
          return block
        }
        if (block && block.transactions?.length === 0) {
          return block
        }
        console.log(`Block ${blockNum}: empty response, retry ${i + 1}/${retries}`)
      } catch (e: any) {
        const isRateLimit = e.message?.includes('429') || e.code === 429 || e.error?.code === 429
        if (isRateLimit) {
          console.log(`Block ${blockNum}: rate limited, switching provider`)
          switchProvider()
          break
        }
        console.log(`Block ${blockNum}: error ${e.message?.slice(0, 50)}, retry ${i + 1}/${retries}`)
      }
      await new Promise(r => setTimeout(r, 500 * (i + 1)))
    }
    if (providerAttempt < RPC_URLS.length - 1) {
      switchProvider()
    }
  }
  return null
}

async function getBlockLogsWithRetry(blockNum: number, retries = 3): Promise<any[]> {
  for (let i = 0; i < retries; i++) {
    try {
      const logs = await provider.getLogs({
        fromBlock: blockNum,
        toBlock: blockNum,
        topics: [[ESIP1_TOPIC, ESIP2_TOPIC, ESIP3_TOPIC]]
      })
      return logs
    } catch (e: any) {
      if (e.message?.includes('429')) {
        switchProvider()
      }
      await new Promise(r => setTimeout(r, 500 * (i + 1)))
    }
  }
  return []
}

// Process ESIP-1 transfer event
async function processEsip1Transfer(
  log: any,
  blockNum: number,
  timestamp: string
): Promise<boolean> {
  try {
    // Decode: TransferEthscription(address indexed recipient, bytes32 indexed ethscriptionId)
    const recipient = ethers.getAddress('0x' + log.topics[1].slice(26)).toLowerCase()
    const ethscriptionId = log.topics[2].toLowerCase()

    const { data: ethscription } = await supabase
      .from('base_ethscriptions')
      .select('id, current_owner')
      .eq('id', ethscriptionId)
      .single()

    if (!ethscription) return false

    const from = ethscription.current_owner

    await supabase
      .from('base_ethscriptions')
      .update({ current_owner: recipient })
      .eq('id', ethscriptionId)

    await supabase.from('base_transfers').insert({
      ethscription_id: ethscriptionId,
      from_address: from,
      to_address: recipient,
      tx_hash: log.transactionHash,
      block_number: blockNum,
      timestamp,
      transfer_type: 'esip1',
      log_index: log.index,
      contract_address: log.address.toLowerCase()
    })

    // Sync token note ownership if applicable
    await syncTokenNoteOwnership(ethscriptionId, recipient)

    console.log(`ESIP-1 Transfer: ${ethscriptionId.slice(0, 10)}... -> ${recipient.slice(0, 10)}...`)
    return true
  } catch (e) {
    return false
  }
}

// Process ESIP-2 safe escrow transfer event
async function processEsip2Transfer(
  log: any,
  blockNum: number,
  timestamp: string
): Promise<boolean> {
  try {
    // Decode: TransferEthscriptionForPreviousOwner(address indexed previousOwner, address indexed recipient, bytes32 indexed ethscriptionId)
    const previousOwner = ethers.getAddress('0x' + log.topics[1].slice(26)).toLowerCase()
    const recipient = ethers.getAddress('0x' + log.topics[2].slice(26)).toLowerCase()
    const ethscriptionId = log.topics[3].toLowerCase()

    const { data: ethscription } = await supabase
      .from('base_ethscriptions')
      .select('id, current_owner')
      .eq('id', ethscriptionId)
      .single()

    if (!ethscription) return false

    // ESIP-2: Verify previous owner matches
    if (ethscription.current_owner !== previousOwner) {
      console.log(`ESIP-2: Previous owner mismatch for ${ethscriptionId.slice(0, 10)}...`)
      return false
    }

    await supabase
      .from('base_ethscriptions')
      .update({ current_owner: recipient })
      .eq('id', ethscriptionId)

    await supabase.from('base_transfers').insert({
      ethscription_id: ethscriptionId,
      from_address: previousOwner,
      to_address: recipient,
      tx_hash: log.transactionHash,
      block_number: blockNum,
      timestamp,
      transfer_type: 'esip2',
      log_index: log.index,
      contract_address: log.address.toLowerCase()
    })

    // Sync token note ownership if applicable
    await syncTokenNoteOwnership(ethscriptionId, recipient)

    console.log(`ESIP-2 Transfer: ${ethscriptionId.slice(0, 10)}... -> ${recipient.slice(0, 10)}...`)
    return true
  } catch (e) {
    return false
  }
}

// Process ESIP-3 smart contract creation event
async function processEsip3Creation(
  log: any,
  blockNum: number,
  timestamp: string
): Promise<boolean> {
  try {
    // Decode: CreateEthscription(address indexed initialOwner, string contentURI)
    const initialOwner = ethers.getAddress('0x' + log.topics[1].slice(26)).toLowerCase()

    // Decode contentURI from data
    const abiCoder = ethers.AbiCoder.defaultAbiCoder()
    const [contentUri] = abiCoder.decode(['string'], log.data)

    if (!contentUri.startsWith('data:')) return false

    // Handle gzip
    const decodedContent = decodeGzipContent(contentUri)
    const hash = sha256(decodedContent)
    const isEsip6 = hasEsip6Rule(contentUri)

    // Check uniqueness (unless ESIP-6)
    if (!isEsip6) {
      const { data: existing } = await supabase
        .from('base_ethscriptions')
        .select('id')
        .eq('id', hash)
        .single()

      if (existing) return false
    }

    // Extract content type
    let contentType = 'text/plain'
    const match = decodedContent.match(/^data:([^,;]+)/)
    if (match && match[1]) {
      contentType = match[1]
    }

    // Get ESIP-6 sequence if needed
    let esip6Sequence = null
    if (isEsip6) {
      const { count } = await supabase
        .from('base_ethscriptions')
        .select('*', { count: 'exact', head: true })
        .eq('id', hash)
      esip6Sequence = (count || 0) + 1
    }

    const { error } = await supabase.from('base_ethscriptions').insert({
      id: isEsip6 ? `${hash}-${esip6Sequence}` : hash,
      content_uri: null,
      content_type: contentType,
      creator: log.address.toLowerCase(),
      current_owner: initialOwner,
      creation_tx: log.transactionHash,
      creation_block: blockNum,
      creation_timestamp: timestamp,
      created_by_contract: true,
      creator_contract: log.address.toLowerCase(),
      esip6: isEsip6,
      esip6_sequence: esip6Sequence
    })

    if (error) return false

    console.log(`ESIP-3 Creation: ${decodedContent.slice(0, 40)}... by contract`)

    // Process protocol handlers for contract-created ethscriptions
    await processProtocolHandlers(decodedContent, isEsip6 ? `${hash}-${esip6Sequence}` : hash, initialOwner, log.transactionHash, blockNum, timestamp)

    return true
  } catch (e) {
    return false
  }
}

// Sync token note ownership when ethscription transfers
async function syncTokenNoteOwnership(ethscriptionId: string, newOwner: string) {
  // Fixed denomination tokens
  await supabase
    .from('base_token_notes')
    .update({ owner: newOwner })
    .eq('ethscription_id', ethscriptionId)

  // Bonding curve tokens
  await supabase
    .from('base_bonding_notes')
    .update({ owner: newOwner })
    .eq('ethscription_id', ethscriptionId)
}

// Process protocol handlers (collections and tokens)
async function processProtocolHandlers(
  content: string,
  ethscriptionId: string,
  owner: string,
  txHash: string,
  blockNum: number,
  timestamp: string
) {
  const json = parseProtocolJson(content)
  if (!json || !json.p) return

  const protocol = json.p
  const operation = json.op

  if (protocol === 'erc-721-ethscriptions-collection') {
    await processCollectionOperation(json, ethscriptionId, owner, txHash, blockNum, timestamp)
  } else if (protocol === 'erc-20-fixed-denomination') {
    await processTokenOperation(json, ethscriptionId, owner, txHash, blockNum, timestamp)
  } else if (protocol === 'erc-20-bonding-curve') {
    await processBondingCurveOperation(json, ethscriptionId, owner, txHash, blockNum, timestamp)
  }
}

// Process collection operations
async function processCollectionOperation(
  json: any,
  ethscriptionId: string,
  owner: string,
  txHash: string,
  blockNum: number,
  timestamp: string
) {
  const op = json.op

  if (op === 'create_collection_and_add_self' || op === 'create') {
    // Create new collection
    const { error } = await supabase.from('base_collections').insert({
      id: ethscriptionId,
      name: json.name,
      symbol: json.symbol,
      description: json.description,
      max_supply: json.max_supply || json.maxSupply,
      merkle_root: json.merkle_root || json.merkleRoot,
      logo_ethscription_id: json.logo,
      banner_ethscription_id: json.banner,
      owner: owner,
      creation_tx: txHash,
      creation_block: blockNum
    })

    if (!error) {
      console.log(`Collection created: ${json.name}`)

      // If create_collection_and_add_self, add the first item
      if (op === 'create_collection_and_add_self' && json.item) {
        await addCollectionItem(ethscriptionId, json.item, ethscriptionId, txHash, blockNum, timestamp)
      }
    }
  } else if (op === 'add_self_to_collection' || op === 'add') {
    // Add item to collection
    const collectionId = json.collection_id || json.collectionId
    if (collectionId) {
      await addCollectionItem(collectionId, json, ethscriptionId, txHash, blockNum, timestamp)
    }
  } else if (op === 'edit_collection') {
    // Update collection metadata
    const updates: any = {}
    if (json.name) updates.name = json.name
    if (json.symbol) updates.symbol = json.symbol
    if (json.description) updates.description = json.description

    const collectionId = json.collection_id || json.collectionId
    if (collectionId && Object.keys(updates).length > 0) {
      await supabase
        .from('base_collections')
        .update(updates)
        .eq('id', collectionId)
        .eq('owner', owner) // Only owner can edit
    }
  } else if (op === 'lock_collection') {
    const collectionId = json.collection_id || json.collectionId
    if (collectionId) {
      await supabase
        .from('base_collections')
        .update({ locked: true })
        .eq('id', collectionId)
        .eq('owner', owner)
      console.log(`Collection locked: ${collectionId.slice(0, 10)}...`)
    }
  } else if (op === 'transfer_ownership') {
    const collectionId = json.collection_id || json.collectionId
    const newOwner = json.new_owner || json.newOwner
    if (collectionId && newOwner) {
      await supabase
        .from('base_collections')
        .update({ owner: newOwner.toLowerCase() })
        .eq('id', collectionId)
        .eq('owner', owner)
      console.log(`Collection ownership transferred: ${collectionId.slice(0, 10)}...`)
    }
  }
}

async function addCollectionItem(
  collectionId: string,
  itemData: any,
  ethscriptionId: string,
  txHash: string,
  blockNum: number,
  timestamp: string
) {
  // Check collection exists and not locked
  const { data: collection } = await supabase
    .from('base_collections')
    .select('id, max_supply, locked')
    .eq('id', collectionId)
    .single()

  if (!collection || collection.locked) return

  // Get next item index
  const { count } = await supabase
    .from('base_collection_items')
    .select('*', { count: 'exact', head: true })
    .eq('collection_id', collectionId)

  const itemIndex = (count || 0) + 1

  // Check max supply
  if (collection.max_supply && itemIndex > collection.max_supply) {
    console.log(`Collection ${collectionId.slice(0, 10)}... is full`)
    return
  }

  const { error } = await supabase.from('base_collection_items').insert({
    collection_id: collectionId,
    ethscription_id: ethscriptionId,
    item_index: itemIndex,
    name: itemData.name || itemData.item_name,
    description: itemData.description || itemData.item_description,
    background_color: itemData.background_color || itemData.backgroundColor,
    attributes: itemData.attributes,
    added_tx: txHash,
    added_block: blockNum
  })

  if (!error) {
    console.log(`Added item #${itemIndex} to collection ${collectionId.slice(0, 10)}...`)
  }
}

// Process token operations
async function processTokenOperation(
  json: any,
  ethscriptionId: string,
  owner: string,
  txHash: string,
  blockNum: number,
  timestamp: string
) {
  const op = json.op

  if (op === 'deploy') {
    // Deploy new token
    const tick = json.tick?.toLowerCase()
    const max = BigInt(json.max || '0')
    const lim = BigInt(json.lim || '0')

    if (!tick || tick.length > 28 || max <= 0 || lim <= 0) return
    if (max % lim !== 0n) {
      console.log(`Token ${tick}: max supply not divisible by denomination`)
      return
    }

    // Check if already exists
    const { data: existing } = await supabase
      .from('base_tokens')
      .select('tick')
      .eq('tick', tick)
      .single()

    if (existing) {
      console.log(`Token ${tick} already exists`)
      return
    }

    const { error } = await supabase.from('base_tokens').insert({
      tick,
      max_supply: max.toString(),
      denomination: lim.toString(),
      minted: '0',
      deploy_ethscription_id: ethscriptionId,
      deploy_tx: txHash,
      deployer: owner
    })

    if (!error) {
      console.log(`Token deployed: ${tick} (max: ${max}, lim: ${lim})`)
    }
  } else if (op === 'mint') {
    // Mint token note
    const tick = json.tick?.toLowerCase()
    const amt = json.amt ? BigInt(json.amt) : null

    if (!tick) return

    // Get token info
    const { data: token } = await supabase
      .from('base_tokens')
      .select('*')
      .eq('tick', tick)
      .single()

    if (!token) {
      console.log(`Token ${tick} not found`)
      return
    }

    const denomination = BigInt(token.denomination)
    const maxSupply = BigInt(token.max_supply)
    const minted = BigInt(token.minted)

    // Amount must equal denomination (or be omitted to use denomination)
    const mintAmount = amt || denomination
    if (mintAmount !== denomination) {
      console.log(`Token ${tick}: mint amount must equal denomination`)
      return
    }

    // Check max supply
    if (minted + mintAmount > maxSupply) {
      console.log(`Token ${tick}: would exceed max supply`)
      return
    }

    // Get next note ID
    const { count } = await supabase
      .from('base_token_notes')
      .select('*', { count: 'exact', head: true })
      .eq('tick', tick)

    const noteId = (count || 0) + 1

    // Create note
    const { error: noteError } = await supabase.from('base_token_notes').insert({
      tick,
      note_id: noteId,
      ethscription_id: ethscriptionId,
      owner,
      amount: mintAmount.toString(),
      mint_tx: txHash,
      mint_block: blockNum
    })

    if (noteError) return

    // Update minted amount
    await supabase
      .from('base_tokens')
      .update({ minted: (minted + mintAmount).toString() })
      .eq('tick', tick)

    console.log(`Token ${tick}: minted note #${noteId} (${mintAmount}) to ${owner.slice(0, 10)}...`)
  }
}

// Process bonding curve token operations
async function processBondingCurveOperation(
  json: any,
  ethscriptionId: string,
  owner: string,
  txHash: string,
  blockNum: number,
  timestamp: string
) {
  const op = json.op

  if (op === 'deploy') {
    // Deploy new bonding curve token
    const tick = json.tick?.toLowerCase()
    const max = BigInt(json.max || '0')
    const lim = BigInt(json.lim || '0')
    const basePrice = BigInt(json.base || '0')
    const priceIncrement = BigInt(json.inc || '0')

    if (!tick || tick.length > 28 || max <= 0 || lim <= 0 || basePrice <= 0) return

    // Check if already exists
    const { data: existing } = await supabase
      .from('base_bonding_tokens')
      .select('tick')
      .eq('tick', tick)
      .single()

    if (existing) {
      console.log(`Bonding curve token ${tick} already exists`)
      return
    }

    const { error } = await supabase.from('base_bonding_tokens').insert({
      tick,
      max_supply: max.toString(),
      denomination: lim.toString(),
      base_price: basePrice.toString(),
      price_increment: priceIncrement.toString(),
      minted: '0',
      reserve: '0',
      deploy_ethscription_id: ethscriptionId,
      deploy_tx: txHash,
      deployer: owner
    })

    if (!error) {
      console.log(`Bonding curve token deployed: ${tick} (max: ${max}, lim: ${lim}, base: ${basePrice} wei)`)
    }
  } else if (op === 'mint') {
    // Mint bonding curve token note (created by contract via buy())
    const tick = json.tick?.toLowerCase()

    if (!tick) return

    // Get token info
    const { data: token } = await supabase
      .from('base_bonding_tokens')
      .select('*')
      .eq('tick', tick)
      .single()

    if (!token) {
      console.log(`Bonding curve token ${tick} not found`)
      return
    }

    const denomination = BigInt(token.denomination)
    const maxSupply = BigInt(token.max_supply)
    const minted = BigInt(token.minted)

    // Check max supply
    if (minted + denomination > maxSupply) {
      console.log(`Bonding curve token ${tick}: would exceed max supply`)
      return
    }

    // Get next note ID
    const { count } = await supabase
      .from('base_bonding_notes')
      .select('*', { count: 'exact', head: true })
      .eq('tick', tick)

    const noteId = (count || 0) + 1

    // Create note
    const { error: noteError } = await supabase.from('base_bonding_notes').insert({
      tick,
      note_id: noteId,
      ethscription_id: ethscriptionId,
      owner,
      amount: denomination.toString(),
      mint_tx: txHash,
      mint_block: blockNum
    })

    if (noteError) return

    // Update minted amount
    await supabase
      .from('base_bonding_tokens')
      .update({ minted: (minted + denomination).toString() })
      .eq('tick', tick)

    console.log(`Bonding curve ${tick}: minted note #${noteId} (${denomination}) to ${owner.slice(0, 10)}...`)
  }
}

async function processBlock(blockNum: number): Promise<{ created: number; transferred: number; events: number }> {
  let created = 0
  let transferred = 0
  let events = 0

  const block = await getBlockWithRetry(blockNum)
  if (!block) {
    console.log(`Block ${blockNum}: FAILED after retries`)
    return { created: 0, transferred: 0, events: 0 }
  }

  const txs = block.prefetchedTransactions || []
  const timestamp = new Date(block.timestamp * 1000).toISOString()

  // Process regular transactions
  for (const tx of txs) {
    if (!tx.to) continue

    const from = tx.from.toLowerCase()
    const to = tx.to.toLowerCase()

    // Self-transfer = creation
    if (from === to) {
      const content = hexToUtf8(tx.data)
      if (!content || !content.startsWith('data:')) continue

      // ESIP-7: Handle gzip compression
      const decodedContent = decodeGzipContent(content)
      const hash = sha256(decodedContent)

      // ESIP-6: Check for non-uniqueness opt-in
      const isEsip6 = hasEsip6Rule(content)

      // Extract content type
      let contentType = 'text/plain'
      const match = decodedContent.match(/^data:([^,;]+)/)
      if (match && match[1]) {
        contentType = match[1]
      }

      // Check uniqueness (unless ESIP-6)
      let shouldInsert = true
      let esip6Sequence = null

      if (!isEsip6) {
        const { data: existing } = await supabase
          .from('base_ethscriptions')
          .select('id')
          .eq('id', hash)
          .single()

        if (existing) shouldInsert = false
      } else {
        // ESIP-6: Get sequence number for this content hash
        const { count } = await supabase
          .from('base_ethscriptions')
          .select('*', { count: 'exact', head: true })
          .eq('id', hash)
        esip6Sequence = (count || 0) + 1
      }

      if (shouldInsert) {
        const ethscriptionId = isEsip6 ? `${hash}-${esip6Sequence}` : hash

        const { error } = await supabase.from('base_ethscriptions').insert({
          id: ethscriptionId,
          content_uri: null,
          content_type: contentType,
          creator: from,
          current_owner: from,
          creation_tx: tx.hash,
          creation_block: blockNum,
          creation_timestamp: timestamp,
          esip6: isEsip6,
          esip6_sequence: esip6Sequence
        })

        if (error) {
          console.log(`Insert error for ${decodedContent.slice(0, 30)}: ${error.message}`)
        } else {
          console.log(`NEW: ${decodedContent.slice(0, 50)}${isEsip6 ? ' [ESIP-6]' : ''} in block ${blockNum}`)
          created++

          // Process protocol handlers
          await processProtocolHandlers(decodedContent, ethscriptionId, from, tx.hash, blockNum, timestamp)
        }
      }
    }
    // ESIP-5: Bulk transfers (multiple 32-byte hashes)
    else if (tx.data.length >= 66 && (tx.data.length - 2) % 64 === 0) {
      const numHashes = (tx.data.length - 2) / 64

      for (let i = 0; i < numHashes; i++) {
        const hash = ('0x' + tx.data.slice(2 + i * 64, 2 + (i + 1) * 64)).toLowerCase()

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
            timestamp,
            transfer_type: 'eoa'
          })

          // Sync token note ownership
          await syncTokenNoteOwnership(hash, to)

          transferred++

          if (numHashes > 1) {
            console.log(`ESIP-5 Bulk Transfer: ${i + 1}/${numHashes} in tx ${tx.hash.slice(0, 10)}...`)
          }
        }
      }
    }
  }

  // Process smart contract events (ESIP-1, ESIP-2, ESIP-3)
  const logs = await getBlockLogsWithRetry(blockNum)
  for (const log of logs) {
    if (log.topics[0] === ESIP1_TOPIC) {
      if (await processEsip1Transfer(log, blockNum, timestamp)) events++
    } else if (log.topics[0] === ESIP2_TOPIC) {
      if (await processEsip2Transfer(log, blockNum, timestamp)) events++
    } else if (log.topics[0] === ESIP3_TOPIC) {
      if (await processEsip3Creation(log, blockNum, timestamp)) {
        events++
        created++
      }
    }
  }

  return { created, transferred, events }
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
  console.log('ESIP Support: ESIP-1, ESIP-2, ESIP-3, ESIP-5, ESIP-6, ESIP-7')
  console.log('Features: Collections, Fixed Denomination Tokens')
  console.log(`Primary RPC: ${RPC_URLS[0]}`)
  console.log(`Fallback RPCs: ${RPC_URLS.slice(1).join(', ')}\n`)

  let totalCreated = 0
  let totalTransferred = 0
  let totalEvents = 0

  // Run continuously
  while (true) {
    const currentBlock = await getBlockNumberWithFallback()
    const startBlock = await getStartBlock()

    if (startBlock >= currentBlock) {
      // Already caught up, wait for new blocks
      await new Promise(r => setTimeout(r, 2000))
      continue
    }

    let processed = startBlock
    const startTime = Date.now()

    while (processed < currentBlock) {
      const batchEnd = Math.min(processed + BATCH_SIZE, currentBlock)
      const blockNums = Array.from({ length: batchEnd - processed }, (_, i) => processed + i)

      // Process blocks with limited concurrency (5 at a time)
      const results: { created: number; transferred: number; events: number }[] = []
      const concurrency = 5
      for (let i = 0; i < blockNums.length; i += concurrency) {
        const batch = blockNums.slice(i, i + concurrency)
        const batchResults = await Promise.all(batch.map(blockNum => processBlock(blockNum)))
        results.push(...batchResults)
      }

      for (const r of results) {
        totalCreated += r.created
        totalTransferred += r.transferred
        totalEvents += r.events
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
        `| Found: ${totalCreated} created, ${totalTransferred} transferred, ${totalEvents} events`
      )

      await supabase
        .from('indexer_state')
        .upsert({ key: 'base_ethscriptions', value: processed.toString(), updated_at: new Date().toISOString() })

      // Small delay between batches to avoid rate limits
      await new Promise(r => setTimeout(r, 50))
    }

    // Caught up, wait briefly then check for new blocks
    await new Promise(r => setTimeout(r, 500))
  }
}

main().catch(console.error)
