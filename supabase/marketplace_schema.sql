-- Marketplace Tables for Basescriptions
-- Run this in Supabase SQL Editor

-- Marketplace Listings
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ethscription_id TEXT NOT NULL,
  name TEXT NOT NULL,
  seller_address TEXT NOT NULL,
  price_wei TEXT NOT NULL,
  price_eth NUMERIC GENERATED ALWAYS AS (price_wei::numeric / 1e18) STORED,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'cancelled')),
  deposit_tx TEXT,
  list_tx TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for listings
CREATE INDEX IF NOT EXISTS idx_listings_status ON marketplace_listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON marketplace_listings(seller_address);
CREATE INDEX IF NOT EXISTS idx_listings_ethscription ON marketplace_listings(ethscription_id);
CREATE INDEX IF NOT EXISTS idx_listings_name ON marketplace_listings(name);
CREATE INDEX IF NOT EXISTS idx_listings_price ON marketplace_listings(price_eth);
CREATE INDEX IF NOT EXISTS idx_listings_created ON marketplace_listings(created_at DESC);

-- Marketplace Offers
CREATE TABLE IF NOT EXISTS marketplace_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES marketplace_listings(id),
  ethscription_id TEXT NOT NULL,
  buyer_address TEXT NOT NULL,
  offer_wei TEXT NOT NULL,
  offer_eth NUMERIC GENERATED ALWAYS AS (offer_wei::numeric / 1e18) STORED,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired')),
  offer_tx TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for offers
CREATE INDEX IF NOT EXISTS idx_offers_listing ON marketplace_offers(listing_id);
CREATE INDEX IF NOT EXISTS idx_offers_buyer ON marketplace_offers(buyer_address);
CREATE INDEX IF NOT EXISTS idx_offers_status ON marketplace_offers(status);

-- Marketplace Sales (completed transactions)
CREATE TABLE IF NOT EXISTS marketplace_sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID,
  ethscription_id TEXT NOT NULL,
  name TEXT NOT NULL,
  seller_address TEXT NOT NULL,
  buyer_address TEXT NOT NULL,
  sale_price_wei TEXT NOT NULL,
  sale_price_eth NUMERIC GENERATED ALWAYS AS (sale_price_wei::numeric / 1e18) STORED,
  fee_wei TEXT,
  purchase_tx TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for sales
CREATE INDEX IF NOT EXISTS idx_sales_seller ON marketplace_sales(seller_address);
CREATE INDEX IF NOT EXISTS idx_sales_buyer ON marketplace_sales(buyer_address);
CREATE INDEX IF NOT EXISTS idx_sales_name ON marketplace_sales(name);
CREATE INDEX IF NOT EXISTS idx_sales_created ON marketplace_sales(created_at DESC);

-- View for active listings with offer stats
CREATE OR REPLACE VIEW marketplace_active_listings AS
SELECT
  l.*,
  COALESCE(o.offer_count, 0) as offer_count,
  o.highest_offer
FROM marketplace_listings l
LEFT JOIN (
  SELECT
    listing_id,
    COUNT(*) as offer_count,
    MAX(offer_eth) as highest_offer
  FROM marketplace_offers
  WHERE status = 'pending'
  GROUP BY listing_id
) o ON l.id = o.listing_id
WHERE l.status = 'active';

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for listings updated_at
DROP TRIGGER IF EXISTS listings_updated_at ON marketplace_listings;
CREATE TRIGGER listings_updated_at
  BEFORE UPDATE ON marketplace_listings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- RLS Policies (allow all for now, service key bypasses anyway)
ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_sales ENABLE ROW LEVEL SECURITY;

-- Allow public read
CREATE POLICY "Allow public read listings" ON marketplace_listings FOR SELECT USING (true);
CREATE POLICY "Allow public read offers" ON marketplace_offers FOR SELECT USING (true);
CREATE POLICY "Allow public read sales" ON marketplace_sales FOR SELECT USING (true);

-- Allow service role all operations
CREATE POLICY "Allow service all listings" ON marketplace_listings FOR ALL USING (true);
CREATE POLICY "Allow service all offers" ON marketplace_offers FOR ALL USING (true);
CREATE POLICY "Allow service all sales" ON marketplace_sales FOR ALL USING (true);
