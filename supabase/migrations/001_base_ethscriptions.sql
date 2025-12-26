-- Base Ethscriptions Schema
-- Run this in Supabase SQL editor

-- Ethscriptions table
CREATE TABLE base_ethscriptions (
  id TEXT PRIMARY KEY,                    -- sha256 hash (0x...)
  content_uri TEXT NOT NULL,              -- raw content (data:,hello)
  content_type TEXT DEFAULT 'text/plain', -- mime type
  creator TEXT NOT NULL,                  -- address
  current_owner TEXT NOT NULL,            -- address
  creation_tx TEXT NOT NULL,              -- tx hash
  creation_block BIGINT NOT NULL,
  creation_timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transfers table
CREATE TABLE base_transfers (
  id SERIAL PRIMARY KEY,
  ethscription_id TEXT REFERENCES base_ethscriptions(id),
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexer state
CREATE TABLE indexer_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX idx_ethscriptions_owner ON base_ethscriptions(current_owner);
CREATE INDEX idx_ethscriptions_creator ON base_ethscriptions(creator);
CREATE INDEX idx_ethscriptions_block ON base_ethscriptions(creation_block);
CREATE INDEX idx_ethscriptions_content ON base_ethscriptions(content_uri);
CREATE INDEX idx_transfers_ethscription ON base_transfers(ethscription_id);
CREATE INDEX idx_transfers_from ON base_transfers(from_address);
CREATE INDEX idx_transfers_to ON base_transfers(to_address);
CREATE INDEX idx_transfers_block ON base_transfers(block_number);

-- Enable RLS (optional, configure as needed)
ALTER TABLE base_ethscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE base_transfers ENABLE ROW LEVEL SECURITY;

-- Public read access
CREATE POLICY "Public read access" ON base_ethscriptions FOR SELECT USING (true);
CREATE POLICY "Public read access" ON base_transfers FOR SELECT USING (true);
