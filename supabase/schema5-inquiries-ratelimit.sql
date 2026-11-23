-- ============================================================
-- Velanzo — Migration 5: inquiries + rate limiting on every endpoint.
-- Run ONCE in Supabase SQL Editor (after schema4-image-colors.sql).
-- ============================================================

-- ---------- Rate limiting core ----------
-- One row per hit. Not exposed to the API (RLS on, no policies).
create table if not exists rate_limits (
  id bigserial primary key,
  bucket text not null,          -- e.g. 'inquiry:ip:1.2.3.4'
  created_at timestamptz not null default now()
);
create index if not exists rate_limits_bucket_time on rate_limits (bucket, created_at);
alter table rate_limits enable row level security;

-- Caller IP as seen by Supabase's API gateway.
create or replace function client_ip() returns text
language sql stable as $$
  select coalesce(
    nullif((current_setting('request.headers', true)::json ->> 'cf-connecting-ip'), ''),
    nullif(trim(split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1)), ''),
    'unknown');
$$;

-- Records a hit and raises if the bucket exceeded p_max hits within p_window.
create or replace function hit_rate_limit(p_bucket text, p_max int, p_window interval)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from rate_limits
       where bucket = p_bucket and created_at > now() - p_window) >= p_max then
    raise exception 'Too many requests. Please slow down and try again later.'
      using errcode = 'P0429';
  end if;
  insert into rate_limits (bucket) values (p_bucket);
  -- Opportunistic cleanup of old rows.
  if random() < 0.01 then
    delete from rate_limits where created_at < now() - interval '1 day';
  end if;
end $$;
revoke all on function hit_rate_limit(text, int, interval) from public, anon, authenticated;

-- ---------- Inquiries ----------
create table if not exists inquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null default 'contact',      -- 'quotation' | 'contact'
  name text not null,
  email text not null,
  phone text not null default '',
  company text not null default '',
  quantity text not null default '',
  subject text not null default '',
  message text not null,
  status text not null default 'new' check (status in ('new','read','replied','closed'))
);
create index if not exists inquiries_created on inquiries (created_at desc);
alter table inquiries enable row level security;

drop policy if exists "inq read" on inquiries;
drop policy if exists "inq update" on inquiries;
drop policy if exists "inq delete" on inquiries;
create policy "inq read"   on inquiries for select to authenticated using (is_admin());
create policy "inq update" on inquiries for update to authenticated using (is_admin()) with check (is_admin());
create policy "inq delete" on inquiries for delete to authenticated using (is_admin());
-- No insert policy: public submissions only go through submit_inquiry().

create or replace function submit_inquiry(
  p_kind text, p_name text, p_email text, p_phone text,
  p_company text, p_quantity text, p_subject text, p_message text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_name is null or length(trim(p_name)) < 2 then raise exception 'Please enter your name.'; end if;
  if p_email is null or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Please enter a valid email.'; end if;
  if p_message is null or length(trim(p_message)) < 5 then raise exception 'Please write a message.'; end if;

  perform hit_rate_limit('inquiry:ip:' || client_ip(), 5, interval '1 hour');
  perform hit_rate_limit('inquiry:email:' || lower(trim(p_email)), 3, interval '1 hour');
  perform hit_rate_limit('inquiry:global', 200, interval '1 hour');

  insert into inquiries (kind, name, email, phone, company, quantity, subject, message)
  values (case when p_kind = 'quotation' then 'quotation' else 'contact' end,
          left(trim(p_name), 120), lower(left(trim(p_email), 200)),
          coalesce(left(trim(p_phone), 40), ''), coalesce(left(trim(p_company), 120), ''),
          coalesce(left(trim(p_quantity), 60), ''), coalesce(left(trim(p_subject), 120), ''),
          left(trim(p_message), 4000))
  returning id into v_id;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function submit_inquiry(text,text,text,text,text,text,text,text) to anon, authenticated;

-- ---------- place_order: add per-IP + global limits ----------
create or replace function place_order(
  p_name text, p_email text, p_phone text, p_address text, p_city text, p_items jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order_id uuid;
  v_order_number text;
  v_total integer := 0;
  v_item jsonb;
  v_product products%rowtype;
  v_qty int;
begin
  if p_name is null or length(trim(p_name)) < 2 then raise exception 'Please enter your name.'; end if;
  if p_email is null or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Please enter a valid email.'; end if;
  if p_address is null or length(trim(p_address)) < 5 then raise exception 'Please enter a delivery address.'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Your bag is empty.'; end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'Too many items in one order.'; end if;

  perform hit_rate_limit('order:ip:' || client_ip(), 10, interval '1 hour');
  perform hit_rate_limit('order:email:' || lower(trim(p_email)), 5, interval '1 hour');
  perform hit_rate_limit('order:global', 500, interval '1 hour');

  v_order_number := 'LW-' || upper(substring(md5(random()::text || clock_timestamp()::text), 1, 8));

  insert into orders (order_number, customer_name, email, phone, address, city, user_id)
  values (v_order_number, trim(p_name), lower(trim(p_email)),
          coalesce(left(p_phone, 40), ''), left(p_address, 500), coalesce(left(p_city, 100), ''),
          auth.uid())
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from products where id = (v_item->>'id')::uuid and active;
    if not found then raise exception 'A product in your bag is no longer available.'; end if;
    v_qty := coalesce((v_item->>'qty')::int, 1);
    if v_qty < 1 or v_qty > 20 then raise exception 'Invalid quantity.'; end if;
    v_total := v_total + v_product.price * v_qty;
    insert into order_items (order_id, product_id, name, price, color, size, qty, image)
    values (v_order_id, v_product.id, v_product.name, v_product.price,
            coalesce(left(v_item->>'color', 40), ''), coalesce(left(v_item->>'size', 20), ''),
            v_qty, coalesce(v_product.images->>0, ''));
  end loop;

  update orders set total = v_total where id = v_order_id;
  return jsonb_build_object('order_number', v_order_number, 'total', v_total);
end $$;

-- ---------- track_order: stop order-number brute forcing ----------
create or replace function track_order(p_order_number text, p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order orders%rowtype;
  v_items jsonb;
begin
  perform hit_rate_limit('track:ip:' || client_ip(), 20, interval '10 minutes');

  select * into v_order from orders
   where order_number = upper(trim(p_order_number))
     and email = lower(trim(p_email));
  if not found then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'name', name, 'price', price, 'color', color,
           'size', size, 'qty', qty, 'image', image)), '[]'::jsonb)
    into v_items from order_items where order_id = v_order.id;

  return jsonb_build_object(
    'order_number', v_order.order_number,
    'status', v_order.status,
    'total', v_order.total,
    'customer_name', v_order.customer_name,
    'city', v_order.city,
    'placed_at', v_order.created_at,
    'updated_at', v_order.updated_at,
    'items', v_items);
end $$;

-- ---------- Table writes (carts, profiles, admin edits) ----------
-- Per-user write throttle applied via trigger to every writable table.
create or replace function throttle_writes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform hit_rate_limit('write:' || tg_table_name || ':' || coalesce(auth.uid()::text, client_ip()),
                         tg_argv[0]::int, interval '1 minute');
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['carts','profiles'] loop
    execute format('drop trigger if exists throttle on %I', t);
    execute format('create trigger throttle before insert or update or delete on %I
                    for each statement execute function throttle_writes(%L)', t, '60');
  end loop;
  foreach t in array array['products','categories','orders','inquiries'] loop
    execute format('drop trigger if exists throttle on %I', t);
    execute format('create trigger throttle before insert or update or delete on %I
                    for each statement execute function throttle_writes(%L)', t, '120');
  end loop;
end $$;

-- ============================================================
-- ALSO (dashboard, no SQL): Authentication -> Rate Limits.
-- Keep sign-in / sign-up / OTP / password-reset limits on — those
-- auth endpoints are rate limited by Supabase itself.
-- ============================================================
