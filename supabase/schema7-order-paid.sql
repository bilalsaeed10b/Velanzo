-- ============================================================
-- Velanzo — Migration 7: "Paid" flag on orders.
-- Run ONCE in Supabase SQL Editor (after schema6-order-delete.sql).
-- Only paid orders count as received revenue in the admin dashboard.
-- ============================================================
alter table orders add column if not exists paid boolean not null default false;
