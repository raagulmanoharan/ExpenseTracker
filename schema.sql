-- ===================================================================
-- Budgy Expense Tracker — Supabase PostgreSQL Schema
-- Run this in Supabase SQL Editor to set up the database
-- ===================================================================

-- ─── Users Table ───────────────────────────────────────────────────
CREATE TABLE users (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone           TEXT NOT NULL UNIQUE,
  name            TEXT,
  salary_type     TEXT CHECK (salary_type IN ('fixed', 'last', 'last_working')),
  salary_day      INTEGER CHECK (salary_day IS NULL OR (salary_day >= 1 AND salary_day <= 31)),
  cards           JSONB DEFAULT '[]'::jsonb,
  statement_dates JSONB DEFAULT '{}'::jsonb,
  joined          TIMESTAMPTZ DEFAULT NOW(),
  expense_count   INTEGER DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  household_id    TEXT,
  shared_categories JSONB DEFAULT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_phone ON users (phone);
CREATE INDEX idx_users_household_id ON users (household_id) WHERE household_id IS NOT NULL;

-- ─── Expenses Table ────────────────────────────────────────────────
CREATE TABLE expenses (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone           TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  date            DATE NOT NULL,
  time            TEXT,
  amount          NUMERIC(12, 2) NOT NULL,
  category        TEXT NOT NULL DEFAULT 'Other',
  merchant        TEXT,
  note            TEXT,
  raw_message     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_expenses_phone ON expenses (phone);
CREATE INDEX idx_expenses_phone_date ON expenses (phone, date DESC);
CREATE INDEX idx_expenses_phone_category ON expenses (phone, category);
CREATE INDEX idx_expenses_created_at ON expenses (created_at DESC);

-- ─── Budgets Table ─────────────────────────────────────────────────
CREATE TABLE budgets (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone           TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  monthly_budget  NUMERIC(12, 2) NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (phone, category)
);

CREATE INDEX idx_budgets_phone ON budgets (phone);

-- ─── Row Level Security (defense-in-depth) ─────────────────────────
-- Service role bypasses RLS, but these are ready for future client access
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;

-- ─── Updated-at trigger ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER budgets_updated_at
  BEFORE UPDATE ON budgets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Atomic increment for expense count ────────────────────────────
CREATE OR REPLACE FUNCTION increment_expense_count(user_phone TEXT)
RETURNS INTEGER AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE users SET expense_count = expense_count + 1
  WHERE phone = user_phone
  RETURNING expense_count INTO new_count;
  RETURN new_count;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════
-- Materialized Views — Spending Insights (Knowledge Graph Foundation)
-- These pre-compute spending patterns for grounded AI conversations.
-- Refresh every 6 hours via pg_cron or on-demand after imports.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Category spending profiles (last 90 days)
-- Who spends how much on what, top merchant per category, frequency
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_category_profiles AS
SELECT
  phone,
  category,
  COUNT(*)::INTEGER AS tx_count,
  ROUND(AVG(amount)::NUMERIC, 0)::INTEGER AS avg_amount,
  ROUND(SUM(amount)::NUMERIC, 0)::INTEGER AS total_amount,
  MAX(amount)::INTEGER AS max_amount,
  MODE() WITHIN GROUP (ORDER BY merchant) AS top_merchant,
  COUNT(DISTINCT merchant)::INTEGER AS merchant_count,
  MAX(date) AS last_seen
FROM expenses
WHERE date >= CURRENT_DATE - INTERVAL '90 days'
GROUP BY phone, category;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_cat_phone_cat ON mv_category_profiles (phone, category);

-- 2. Merchant visit profiles (last 90 days)
-- Which merchants does the user frequent, how much per visit
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_merchant_profiles AS
SELECT
  phone,
  merchant,
  category,
  COUNT(*)::INTEGER AS visit_count,
  ROUND(AVG(amount)::NUMERIC, 0)::INTEGER AS avg_spend,
  ROUND(SUM(amount)::NUMERIC, 0)::INTEGER AS total_spend,
  MAX(date) AS last_visit
FROM expenses
WHERE merchant IS NOT NULL AND date >= CURRENT_DATE - INTERVAL '90 days'
GROUP BY phone, merchant, category;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_merch_phone_merch ON mv_merchant_profiles (phone, merchant, category);

-- 3. Day-of-week spending patterns (last 60 days)
-- When does the user spend the most? Weekend vs weekday patterns
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_dow_patterns AS
SELECT
  phone,
  EXTRACT(DOW FROM date)::INTEGER AS day_of_week,
  category,
  COUNT(*)::INTEGER AS tx_count,
  ROUND(AVG(amount)::NUMERIC, 0)::INTEGER AS avg_amount,
  ROUND(SUM(amount)::NUMERIC, 0)::INTEGER AS total_amount
FROM expenses
WHERE date >= CURRENT_DATE - INTERVAL '60 days'
GROUP BY phone, EXTRACT(DOW FROM date), category;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_dow_phone_dow_cat ON mv_dow_patterns (phone, day_of_week, category);

-- 4. Monthly cycle trends (all time, grouped by month)
-- How spending changes month over month per category
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cycle_trends AS
SELECT
  phone,
  category,
  DATE_TRUNC('month', date)::DATE AS month,
  ROUND(SUM(amount)::NUMERIC, 0)::INTEGER AS total,
  COUNT(*)::INTEGER AS tx_count
FROM expenses
GROUP BY phone, category, DATE_TRUNC('month', date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_trends_phone_cat_month ON mv_cycle_trends (phone, category, month);

-- ─── Refresh function (call manually or via pg_cron) ──────────────
CREATE OR REPLACE FUNCTION refresh_spending_insights()
RETURNS VOID AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_category_profiles;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_merchant_profiles;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_dow_patterns;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_cycle_trends;
END;
$$ LANGUAGE plpgsql;

-- Schedule refresh every 6 hours (requires pg_cron extension enabled in Supabase)
-- Run this separately after enabling pg_cron:
-- SELECT cron.schedule('refresh-spending-insights', '0 */6 * * *', 'SELECT refresh_spending_insights();');

-- ═══════════════════════════════════════════════════════════════════
-- Spending Narratives — vector-embedded spending insights for RAG
-- Requires pgvector extension: enable via Supabase Dashboard > Extensions
-- ═══════════════════════════════════════════════════════════════════

-- Enable pgvector (run once in Supabase SQL Editor)
-- CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS spending_narratives (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone           TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  narrative_type  TEXT NOT NULL,                        -- 'weekly_summary', 'category_profile', 'pattern', 'graph_insight'
  period_start    DATE,                                 -- start of the period this narrative covers
  period_end      DATE,                                 -- end of the period
  content         TEXT NOT NULL,                         -- human-readable spending narrative
  embedding       vector(1024),                          -- Voyage AI voyage-finance-2 embedding
  metadata        JSONB DEFAULT '{}'::jsonb,             -- extra structured data (categories involved, amounts, etc.)
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_narratives_phone ON spending_narratives (phone);
CREATE INDEX IF NOT EXISTS idx_narratives_phone_type ON spending_narratives (phone, narrative_type);
-- HNSW index for fast approximate nearest neighbor search
CREATE INDEX IF NOT EXISTS idx_narratives_embedding ON spending_narratives
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- Trigger for updated_at
CREATE TRIGGER narratives_updated_at
  BEFORE UPDATE ON spending_narratives
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Vector similarity search RPC ──────────────────────────────────
-- Used by insights.js searchNarratives() for semantic retrieval
CREATE OR REPLACE FUNCTION match_narratives(
  query_embedding vector(1024),
  match_phone TEXT,
  match_count INTEGER DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  narrative_type TEXT,
  period_start DATE,
  period_end DATE,
  metadata JSONB,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    sn.id,
    sn.content,
    sn.narrative_type,
    sn.period_start,
    sn.period_end,
    sn.metadata,
    1 - (sn.embedding <=> query_embedding)::FLOAT AS similarity
  FROM spending_narratives sn
  WHERE sn.phone = match_phone
    AND sn.embedding IS NOT NULL
  ORDER BY sn.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;
