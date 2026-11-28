-- ============================================================
-- Velanzo — Migration 12: product stock.
--   products.stock: null = not tracked; a number = units in stock.
--   Every order deducts stock (and fails if not enough is left);
--   cancelling an order puts the stock back.
-- Run ONCE in Supabase SQL Editor (safe to re-run).
-- ============================================================
alter table products add column if not exists stock integer;
do $$ begin
  alter table products add constraint products_stock_chk check (stock is null or stock >= 0);
exception when duplicate_object then null; end $$;

-- Deduct when an order line is created (runs inside place_order).
create or replace function deduct_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_left integer; v_name text;
begin
  update products set stock = stock - new.qty
   where id = new.product_id and stock is not null
   returning stock, name into v_left, v_name;
  if v_left is not null and v_left < 0 then
    select stock + new.qty into v_left from products where id = new.product_id;
    raise exception 'Only % of "%" left in stock. Please reduce the quantity.', v_left, v_name;
  end if;
  return new;
end $$;
drop trigger if exists order_items_deduct_stock on order_items;
create trigger order_items_deduct_stock after insert on order_items
  for each row execute function deduct_stock();

-- Cancel -> restore; un-cancel -> deduct again.
create or replace function restock_on_cancel() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_sign integer;
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then v_sign := 1;
  elsif old.status = 'cancelled' and new.status <> 'cancelled' then v_sign := -1;
  else return new; end if;
  update products p set stock = greatest(0, p.stock + v_sign * i.qty)
    from (select product_id, sum(qty) qty from order_items where order_id = new.id group by product_id) i
   where p.id = i.product_id and p.stock is not null;
  return new;
end $$;
drop trigger if exists orders_restock_on_cancel on orders;
create trigger orders_restock_on_cancel after update of status on orders
  for each row execute function restock_on_cancel();
