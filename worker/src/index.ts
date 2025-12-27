import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createClient } from '@supabase/supabase-js'

type Bindings = {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

// Helper: compute sha256 of content
async function sha256(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

// Helper: get supabase client
function getDb(c: any) {
  return createClient(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY)
}

// GET / - API info
app.get('/', (c) => {
  return c.json({
    name: 'Basescriptions API',
    version: '0.1.0',
    endpoints: {
      '/name/:name': 'Check if name is registered, get owner',
      '/hash/:hash': 'Get ethscription by hash',
      '/owned/:address': 'List ethscriptions owned by address',
      '/created/:address': 'List ethscriptions created by address',
      '/check/:content': 'Check if content would be available',
      '/stats': 'Get indexer stats',
    }
  })
})

// GET /name/:name - Check name availability and owner
app.get('/name/:name', async (c) => {
  const name = c.req.param('name').toLowerCase()
  const content = `data:,${name}`

  const db = getDb(c)
  // Search by content_uri since hashes may vary
  const { data } = await db
    .from('base_ethscriptions')
    .select('*')
    .eq('content_uri', content)
    .single()

  const hash = await sha256(content)

  if (!data) {
    return c.json({
      available: true,
      name,
      hash,
      content
    })
  }

  return c.json({
    available: false,
    name,
    hash: data.id,
    owner: data.current_owner,
    creator: data.creator,
    creation_tx: data.creation_tx,
    creation_block: data.creation_block,
    created_at: data.creation_timestamp
  })
})

// GET /hash/:hash - Get ethscription by hash
app.get('/hash/:hash', async (c) => {
  const hash = c.req.param('hash').toLowerCase()

  const db = getDb(c)
  const { data } = await db
    .from('base_ethscriptions')
    .select('*')
    .eq('id', hash)
    .single()

  if (!data) {
    return c.json({ error: 'Not found' }, 404)
  }

  // Get transfer history
  const { data: transfers } = await db
    .from('base_transfers')
    .select('*')
    .eq('ethscription_id', hash)
    .order('block_number', { ascending: true })

  return c.json({
    ...data,
    transfers: transfers || []
  })
})

// GET /owned/:address - List owned ethscriptions
app.get('/owned/:address', async (c) => {
  const address = c.req.param('address').toLowerCase()
  const limit = parseInt(c.req.query('limit') || '100')
  const offset = parseInt(c.req.query('offset') || '0')

  const db = getDb(c)
  const { data, count } = await db
    .from('base_ethscriptions')
    .select('*', { count: 'exact' })
    .eq('current_owner', address)
    .order('creation_block', { ascending: false })
    .range(offset, offset + limit - 1)

  return c.json({
    address,
    total: count,
    limit,
    offset,
    ethscriptions: data || []
  })
})

// GET /created/:address - List created ethscriptions
app.get('/created/:address', async (c) => {
  const address = c.req.param('address').toLowerCase()
  const limit = parseInt(c.req.query('limit') || '100')
  const offset = parseInt(c.req.query('offset') || '0')

  const db = getDb(c)
  const { data, count } = await db
    .from('base_ethscriptions')
    .select('*', { count: 'exact' })
    .eq('creator', address)
    .order('creation_block', { ascending: false })
    .range(offset, offset + limit - 1)

  return c.json({
    address,
    total: count,
    limit,
    offset,
    ethscriptions: data || []
  })
})

// GET /check/:content - Check if raw content is available
app.get('/check/:content', async (c) => {
  const content = decodeURIComponent(c.req.param('content'))
  const fullContent = content.startsWith('data:,') ? content : `data:,${content}`
  const hash = await sha256(fullContent)

  const db = getDb(c)
  const { data } = await db
    .from('base_ethscriptions')
    .select('id, current_owner')
    .eq('id', hash)
    .single()

  return c.json({
    content: fullContent,
    hash,
    available: !data,
    owner: data?.current_owner || null
  })
})

// GET /stats - Indexer stats
app.get('/stats', async (c) => {
  const db = getDb(c)

  const [ethscriptions, transfers, state] = await Promise.all([
    db.from('base_ethscriptions').select('*', { count: 'exact', head: true }),
    db.from('base_transfers').select('*', { count: 'exact', head: true }),
    db.from('indexer_state').select('*').eq('key', 'base_ethscriptions').single()
  ])

  return c.json({
    total_ethscriptions: ethscriptions.count || 0,
    total_transfers: transfers.count || 0,
    last_indexed_block: state.data?.value ? parseInt(state.data.value) : 0,
    updated_at: state.data?.updated_at || null
  })
})

// GET /recent - Recent ethscriptions with pagination
app.get('/recent', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')

  const db = getDb(c)
  const { data, count } = await db
    .from('base_ethscriptions')
    .select('*', { count: 'exact' })
    .order('creation_block', { ascending: false })
    .range(offset, offset + limit - 1)

  return c.json({
    total: count || 0,
    limit,
    offset,
    ethscriptions: data || []
  })
})

// POST /register - Register a new inscription immediately after tx
app.post('/register', async (c) => {
  try {
    const body = await c.req.json()
    const { content, creator, tx_hash, block_number } = body

    if (!content || !creator || !tx_hash) {
      return c.json({ error: 'Missing required fields' }, 400)
    }

    const hash = await sha256(content)
    const db = getDb(c)

    // Check if already exists
    const { data: existing } = await db
      .from('base_ethscriptions')
      .select('id')
      .eq('id', hash)
      .single()

    if (existing) {
      return c.json({ error: 'Already registered', hash }, 409)
    }

    // Extract content type
    let contentType = 'text/plain'
    const match = content.match(/^data:([^,;]+)/)
    if (match && match[1]) {
      contentType = match[1]
    }

    // Insert
    const { error } = await db.from('base_ethscriptions').insert({
      id: hash,
      content_uri: content,
      content_type: contentType,
      creator: creator.toLowerCase(),
      current_owner: creator.toLowerCase(),
      creation_tx: tx_hash.toLowerCase(),
      creation_block: block_number || 0,
      creation_timestamp: new Date().toISOString()
    })

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ success: true, hash })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// POST /transfer - Record a transfer immediately after tx
app.post('/transfer', async (c) => {
  try {
    const body = await c.req.json()
    const { hash, from, to, tx_hash } = body

    if (!hash || !from || !to || !tx_hash) {
      return c.json({ error: 'Missing required fields' }, 400)
    }

    const db = getDb(c)

    // Update owner
    const { error: updateError } = await db
      .from('base_ethscriptions')
      .update({ current_owner: to.toLowerCase() })
      .eq('id', hash.toLowerCase())
      .eq('current_owner', from.toLowerCase())

    if (updateError) {
      return c.json({ error: updateError.message }, 500)
    }

    // Record transfer
    const { error: insertError } = await db.from('base_transfers').insert({
      ethscription_id: hash.toLowerCase(),
      from_address: from.toLowerCase(),
      to_address: to.toLowerCase(),
      tx_hash: tx_hash.toLowerCase(),
      block_number: 0,
      timestamp: new Date().toISOString()
    })

    if (insertError) {
      console.log('Transfer insert error:', insertError)
    }

    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

export default app
