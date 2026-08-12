-- ============================================================
-- SUPABASE MIGRATION: comparison_history table
-- Purpose: Store comparison results for Premium users so they
--          can revisit past comparisons anytime.
-- Run this in Supabase SQL Editor once.
-- ============================================================

CREATE TABLE IF NOT EXISTS comparison_history (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_a       TEXT NOT NULL,
  product_b       TEXT NOT NULL,
  price_a         NUMERIC(12,2) NOT NULL,
  price_b         NUMERIC(12,2) NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'EGP',
  rows            JSONB NOT NULL,
  final_recommendation JSONB NOT NULL,
  resale_value_a  NUMERIC(5,2) DEFAULT 50,
  resale_value_b  NUMERIC(5,2) DEFAULT 50,
  warranty_score_a NUMERIC(3,1) DEFAULT 5,
  warranty_score_b NUMERIC(3,1) DEFAULT 5,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast per-user lookups (sorted by date)
CREATE INDEX IF NOT EXISTS idx_comparison_history_user_created
  ON comparison_history (user_id, created_at DESC);

-- RLS Policies
ALTER TABLE comparison_history ENABLE ROW LEVEL SECURITY;

-- Users can only see their own comparison history
CREATE POLICY "users_select_own_comparison_history"
  ON comparison_history FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own comparisons (premium-enforced server-side)
CREATE POLICY "users_insert_own_comparison_history"
  ON comparison_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own comparisons
CREATE POLICY "users_delete_own_comparison_history"
  ON comparison_history FOR DELETE
  USING (auth.uid() = user_id);
