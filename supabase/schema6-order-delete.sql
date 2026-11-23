-- ============================================================
-- Velanzo — Migration 6: let admins delete orders.
-- Run ONCE in Supabase SQL Editor (after schema5-inquiries-ratelimit.sql).
-- Order items are removed automatically (on delete cascade).
-- ============================================================
drop policy if exists "orders delete" on orders;
create policy "orders delete" on orders for delete to authenticated using (is_admin());
