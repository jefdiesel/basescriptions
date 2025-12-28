import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createClient } from '@supabase/supabase-js'

type Bindings = {
  SUPABASE_URL: string
  SUPABASE_KEY: string
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

// Helper: get supabase client with service key
function getDb(c: any) {
  return createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY)
}

// Alias for backwards compat
function getDbAdmin(c: any) {
  return getDb(c)
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
    .order('creation_timestamp', { ascending: false })
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
    const db = getDbAdmin(c)

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

    const db = getDbAdmin(c)
    const hashLower = hash.toLowerCase()
    const fromLower = from.toLowerCase()
    const toLower = to.toLowerCase()

    // First verify the inscription exists and check current owner
    const { data: existing } = await db
      .from('base_ethscriptions')
      .select('id, current_owner')
      .eq('id', hashLower)
      .single()

    if (!existing) {
      return c.json({ error: 'Inscription not found' }, 404)
    }

    if (existing.current_owner !== fromLower) {
      return c.json({ error: `Owner mismatch: DB has ${existing.current_owner}, tx from ${fromLower}` }, 400)
    }

    // Update owner
    const { error: updateError } = await db
      .from('base_ethscriptions')
      .update({ current_owner: toLower })
      .eq('id', hashLower)

    if (updateError) {
      return c.json({ error: updateError.message }, 500)
    }

    // Record transfer
    const { error: insertError } = await db.from('base_transfers').insert({
      ethscription_id: hashLower,
      from_address: fromLower,
      to_address: toLower,
      tx_hash: tx_hash.toLowerCase(),
      block_number: 0,
      timestamp: new Date().toISOString()
    })

    if (insertError) {
      return c.json({ error: 'Transfer recorded but history insert failed: ' + insertError.message }, 500)
    }

    return c.json({ success: true, new_owner: toLower })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ============================================
// MARKETPLACE ENDPOINTS
// ============================================

const MARKETPLACE_CONTRACT = '0x0000000000000000000000000000000000000000' // TODO: Deploy and update

// GET /marketplace/listings - Browse listings
app.get('/marketplace/listings', async (c) => {
  const db = getDb(c)
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100)
  const offset = parseInt(c.req.query('offset') || '0')
  const sort = c.req.query('sort') || 'created_at'
  const order = c.req.query('order') || 'desc'
  const search = c.req.query('search')
  const seller = c.req.query('seller')
  const minPrice = c.req.query('minPrice')
  const maxPrice = c.req.query('maxPrice')

  let query = db
    .from('marketplace_active_listings')
    .select('*', { count: 'exact' })

  if (search) query = query.ilike('name', `%${search}%`)
  if (seller) query = query.eq('seller_address', seller.toLowerCase())
  if (minPrice) query = query.gte('price_eth', parseFloat(minPrice))
  if (maxPrice) query = query.lte('price_eth', parseFloat(maxPrice))

  const validSorts = ['created_at', 'price_eth', 'name']
  const sortField = validSorts.includes(sort) ? sort : 'created_at'
  query = query.order(sortField, { ascending: order === 'asc' })
  query = query.range(offset, offset + limit - 1)

  const { data, count, error } = await query

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  return c.json({
    listings: data || [],
    pagination: {
      total: count || 0,
      limit,
      offset,
      pages: Math.ceil((count || 0) / limit)
    }
  })
})

// POST /marketplace/listings - Create listing
app.post('/marketplace/listings', async (c) => {
  try {
    const body = await c.req.json()
    const { name, sellerAddress, priceWei, ethscriptionId, depositTx, listTx } = body

    if (!name || !sellerAddress || !priceWei || !ethscriptionId) {
      return c.json({ error: 'Missing required fields' }, 400)
    }

    const db = getDb(c)

    // Check if already listed
    const { data: existing } = await db
      .from('marketplace_listings')
      .select('id')
      .eq('ethscription_id', ethscriptionId.toLowerCase())
      .eq('status', 'active')
      .single()

    if (existing) {
      return c.json({ error: 'Already listed' }, 409)
    }

    const { data, error } = await db
      .from('marketplace_listings')
      .insert({
        ethscription_id: ethscriptionId.toLowerCase(),
        name: name.toLowerCase(),
        seller_address: sellerAddress.toLowerCase(),
        price_wei: priceWei,
        deposit_tx: depositTx?.toLowerCase(),
        list_tx: listTx?.toLowerCase(),
        status: 'active'
      })
      .select()
      .single()

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ success: true, listing: data })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// GET /marketplace/listing/:id - Get single listing
app.get('/marketplace/listing/:id', async (c) => {
  const id = c.req.param('id')
  const db = getDb(c)

  const { data: listing, error } = await db
    .from('marketplace_listings')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !listing) {
    return c.json({ error: 'Listing not found' }, 404)
  }

  // Get offers
  const { data: offers } = await db
    .from('marketplace_offers')
    .select('*')
    .eq('listing_id', id)
    .eq('status', 'pending')
    .order('offer_eth', { ascending: false })

  return c.json({
    listing,
    offers: offers || []
  })
})

// DELETE /marketplace/listing/:id - Complete sale
app.delete('/marketplace/listing/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const { buyerAddress, purchaseTx, salePriceWei } = body

    if (!buyerAddress || !purchaseTx) {
      return c.json({ error: 'Missing required fields' }, 400)
    }

    const db = getDb(c)

    // Get listing
    const { data: listing } = await db
      .from('marketplace_listings')
      .select('*')
      .eq('id', id)
      .single()

    if (!listing) {
      return c.json({ error: 'Listing not found' }, 404)
    }

    // Record sale
    await db.from('marketplace_sales').insert({
      listing_id: id,
      ethscription_id: listing.ethscription_id,
      name: listing.name,
      seller_address: listing.seller_address,
      buyer_address: buyerAddress.toLowerCase(),
      sale_price_wei: salePriceWei || listing.price_wei,
      purchase_tx: purchaseTx.toLowerCase()
    })

    // Mark listing as sold
    await db
      .from('marketplace_listings')
      .update({ status: 'sold' })
      .eq('id', id)

    // Cancel pending offers
    await db
      .from('marketplace_offers')
      .update({ status: 'cancelled' })
      .eq('listing_id', id)
      .eq('status', 'pending')

    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// POST /marketplace/offers - Make offer
app.post('/marketplace/offers', async (c) => {
  try {
    const body = await c.req.json()
    const { listingId, buyerAddress, offerWei, offerTx, expiresAt } = body

    if (!listingId || !buyerAddress || !offerWei) {
      return c.json({ error: 'Missing required fields' }, 400)
    }

    const db = getDb(c)

    // Get listing
    const { data: listing } = await db
      .from('marketplace_listings')
      .select('ethscription_id')
      .eq('id', listingId)
      .single()

    if (!listing) {
      return c.json({ error: 'Listing not found' }, 404)
    }

    const { data, error } = await db
      .from('marketplace_offers')
      .insert({
        listing_id: listingId,
        ethscription_id: listing.ethscription_id,
        buyer_address: buyerAddress.toLowerCase(),
        offer_wei: offerWei,
        offer_tx: offerTx?.toLowerCase(),
        expires_at: expiresAt,
        status: 'pending'
      })
      .select()
      .single()

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ success: true, offer: data })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// PATCH /marketplace/offers - Accept/Cancel offer
app.patch('/marketplace/offers', async (c) => {
  try {
    const body = await c.req.json()
    const { offerId, action, userAddress } = body

    if (!offerId || !action) {
      return c.json({ error: 'Missing required fields' }, 400)
    }

    const db = getDb(c)

    const { data: offer } = await db
      .from('marketplace_offers')
      .select('*, marketplace_listings!inner(*)')
      .eq('id', offerId)
      .single()

    if (!offer) {
      return c.json({ error: 'Offer not found' }, 404)
    }

    if (action === 'accept') {
      // Record sale
      await db.from('marketplace_sales').insert({
        listing_id: offer.listing_id,
        ethscription_id: offer.ethscription_id,
        name: offer.marketplace_listings.name,
        seller_address: offer.marketplace_listings.seller_address,
        buyer_address: offer.buyer_address,
        sale_price_wei: offer.offer_wei,
        purchase_tx: offer.offer_tx || 'offer-accepted'
      })

      // Mark listing as sold
      await db
        .from('marketplace_listings')
        .update({ status: 'sold' })
        .eq('id', offer.listing_id)

      // Update offer status
      await db
        .from('marketplace_offers')
        .update({ status: 'accepted' })
        .eq('id', offerId)

      // Cancel other pending offers
      await db
        .from('marketplace_offers')
        .update({ status: 'cancelled' })
        .eq('listing_id', offer.listing_id)
        .eq('status', 'pending')
        .neq('id', offerId)

    } else if (action === 'cancel') {
      await db
        .from('marketplace_offers')
        .update({ status: 'cancelled' })
        .eq('id', offerId)
    }

    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// GET /marketplace/stats - Market stats
app.get('/marketplace/stats', async (c) => {
  const db = getDb(c)

  const [listings, sales] = await Promise.all([
    db.from('marketplace_listings').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    db.from('marketplace_sales').select('sale_price_eth')
  ])

  const totalSales = sales.data?.length || 0
  const totalVolume = sales.data?.reduce((sum, s) => sum + parseFloat(s.sale_price_eth), 0) || 0
  const avgPrice = totalSales > 0 ? totalVolume / totalSales : 0

  return c.json({
    stats: {
      activeListings: listings.count || 0,
      totalSales,
      totalVolumeEth: totalVolume,
      avgSalePriceEth: avgPrice
    }
  })
})

// GET /marketplace/activity - Recent activity
app.get('/marketplace/activity', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20')
  const db = getDb(c)

  // Get recent listings
  const { data: recentListings } = await db
    .from('marketplace_listings')
    .select('id, name, price_eth, seller_address, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  // Get recent sales
  const { data: recentSales } = await db
    .from('marketplace_sales')
    .select('id, name, sale_price_eth, seller_address, buyer_address, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  // Get recent offers
  const { data: recentOffers } = await db
    .from('marketplace_offers')
    .select('id, marketplace_listings!inner(name), offer_eth, buyer_address, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)

  // Combine and sort
  const activity = [
    ...(recentListings || []).map(l => ({
      id: l.id,
      type: 'listing' as const,
      name: l.name,
      priceEth: parseFloat(l.price_eth),
      fromAddress: l.seller_address,
      createdAt: l.created_at
    })),
    ...(recentSales || []).map(s => ({
      id: s.id,
      type: 'sale' as const,
      name: s.name,
      priceEth: parseFloat(s.sale_price_eth),
      fromAddress: s.seller_address,
      toAddress: s.buyer_address,
      createdAt: s.created_at
    })),
    ...(recentOffers || []).map(o => ({
      id: o.id,
      type: 'offer' as const,
      name: (o as any).marketplace_listings?.name || 'Unknown',
      priceEth: parseFloat(o.offer_eth),
      fromAddress: o.buyer_address,
      createdAt: o.created_at
    }))
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
   .slice(0, limit)

  return c.json({ activity })
})

// GET /marketplace/history - Price history for a name
app.get('/marketplace/history', async (c) => {
  const name = c.req.query('name')
  if (!name) {
    return c.json({ error: 'Name required' }, 400)
  }

  const db = getDb(c)

  // Get listings
  const { data: listings } = await db
    .from('marketplace_listings')
    .select('price_eth, created_at')
    .eq('name', name.toLowerCase())
    .order('created_at', { ascending: true })

  // Get sales
  const { data: sales } = await db
    .from('marketplace_sales')
    .select('sale_price_eth, created_at, purchase_tx')
    .eq('name', name.toLowerCase())
    .order('created_at', { ascending: true })

  const history = [
    ...(listings || []).map(l => ({
      priceEth: parseFloat(l.price_eth),
      date: l.created_at,
      type: 'listing' as const
    })),
    ...(sales || []).map(s => ({
      priceEth: parseFloat(s.sale_price_eth),
      date: s.created_at,
      type: 'sale' as const,
      txHash: s.purchase_tx
    }))
  ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  const saleItems = history.filter(h => h.type === 'sale')
  const stats = {
    totalSales: saleItems.length,
    avgPrice: saleItems.length > 0 ? saleItems.reduce((s, i) => s + i.priceEth, 0) / saleItems.length : 0,
    minPrice: saleItems.length > 0 ? Math.min(...saleItems.map(i => i.priceEth)) : 0,
    maxPrice: saleItems.length > 0 ? Math.max(...saleItems.map(i => i.priceEth)) : 0,
    lastSalePrice: saleItems.length > 0 ? saleItems[saleItems.length - 1].priceEth : null
  }

  return c.json({ history, stats })
})

export default app
