-- ============================================================
-- Velanzo — Migration 11: per-product size chart.
--   size_chart = { "headers": ["Description","S","M",...],
--                  "rows": [["Length","25.5","26",...], ...] }
-- Run ONCE in Supabase SQL Editor (safe to re-run).
-- ============================================================
alter table products add column if not exists size_chart jsonb;
