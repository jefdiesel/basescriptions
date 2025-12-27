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
  const name = c.req.param('name')
  const content = `data:,${name}`
  const hash = await sha256(content)

  const db = getDb(c)
  const { data } = await db
    .from('base_ethscriptions')
    .select('*')
    .eq('id', hash)
    .single()

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
    hash,
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
    db.from('indexer_state').select('*').eq('key', 'last_block').single()
  ])

  return c.json({
    total_ethscriptions: ethscriptions.count || 0,
    total_transfers: transfers.count || 0,
    last_indexed_block: state.data?.value ? parseInt(state.data.value) : 0,
    updated_at: state.data?.updated_at || null
  })
})

// GET /recent - Recent ethscriptions
app.get('/recent', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50')

  const db = getDb(c)
  const { data } = await db
    .from('base_ethscriptions')
    .select('*')
    .order('creation_block', { ascending: false })
    .limit(limit)

  return c.json({
    ethscriptions: data || []
  })
})

export default app
