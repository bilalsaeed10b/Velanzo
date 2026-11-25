-- ============================================================
-- Velanzo — Migration 10: real checkout.
--   * Shipping: free in Karachi, PKR 100 for other cities (server-computed).
--   * Payment method per order: 'cod' (Cash on Delivery) or 'card' (Safepay).
--   * Order emails via Brevo: customer confirmation + alert to the team.
-- Run ONCE in Supabase SQL Editor, after schema9-email-alerts.sql.
-- ============================================================

alter table orders add column if not exists shipping_fee integer not null default 0;
alter table orders add column if not exists payment_method text not null default 'cod';
alter table orders add column if not exists payment_ref text not null default '';
alter table orders add column if not exists paid_at timestamptz;
do $$ begin
  alter table orders add constraint orders_payment_method_chk check (payment_method in ('cod','card'));
exception when duplicate_object then null; end $$;

-- Shipping rule lives in ONE place.
create or replace function shipping_fee_for(p_city text) returns integer
language sql immutable as $$
  select case when lower(coalesce(p_city, '')) like '%karachi%' then 0 else 100 end;
$$;

-- ---------- Order emails (Brevo, settings from schema9) ----------
create or replace function send_brevo_email(p_to jsonb, p_subject text, p_html text, p_reply_to text default null)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s email_alert_settings%rowtype;
begin
  select * into s from email_alert_settings where id = 1;
  if not found then return; end if;
  perform net.http_post(
    url := 'https://api.brevo.com/v3/smtp/email',
    headers := jsonb_build_object('api-key', s.brevo_key, 'content-type', 'application/json', 'accept', 'application/json'),
    body := jsonb_build_object(
      'sender', jsonb_build_object('name', 'Velanzo', 'email', s.sender_email),
      'to', p_to,
      'subject', p_subject,
      'htmlContent', p_html)
      || case when p_reply_to is not null then jsonb_build_object('replyTo', jsonb_build_object('email', p_reply_to)) else '{}'::jsonb end);
exception when others then null;  -- an email problem must never break an order
end $$;
revoke all on function send_brevo_email(jsonb, text, text, text) from public, anon, authenticated;

create or replace function h(t text) returns text language sql immutable as $$
  select replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
$$;

-- p_event: 'placed' (COD order placed) or 'paid' (card payment confirmed).
create or replace function notify_order(p_order_id uuid, p_event text) returns void
language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype;
  s email_alert_settings%rowtype;
  lines text;
  pay text;
  summary text;
begin
  select * into o from orders where id = p_order_id;
  if not found then return; end if;

  select string_agg('<tr><td>' || h(name) || coalesce(nullif(' (' || h(concat_ws(' · ', nullif(size, ''), nullif(color, ''))) || ')', ' ()'), '')
                    || ' × ' || qty || '</td><td align="right">PKR ' || to_char(price * qty, 'FM999,999,999') || '</td></tr>', '')
    into lines from order_items where order_id = o.id;

  pay := case when o.payment_method = 'card' then 'Card (paid online)' else 'Cash on Delivery' end;
  summary :=
    '<table cellpadding="6" style="border-collapse:collapse;width:100%;max-width:520px;font-family:Arial,sans-serif;font-size:14px">'
    || coalesce(lines, '')
    || '<tr><td>Shipping</td><td align="right">' || case when o.shipping_fee = 0 then 'Free' else 'PKR ' || o.shipping_fee end || '</td></tr>'
    || '<tr><td><b>Total</b></td><td align="right"><b>PKR ' || to_char(o.total, 'FM999,999,999') || '</b></td></tr></table>'
    || '<p style="font-family:Arial,sans-serif;font-size:14px">Payment: ' || pay || '<br>Deliver to: ' || h(o.customer_name) || ', '
    || h(o.address) || case when o.city <> '' then ', ' || h(o.city) else '' end
    || case when o.phone <> '' then '<br>Phone: ' || h(o.phone) else '' end || '</p>';

  -- Customer confirmation
  perform send_brevo_email(
    jsonb_build_array(jsonb_build_object('email', o.email, 'name', o.customer_name)),
    'Your Velanzo order ' || o.order_number || ' is confirmed',
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">'
    || '<h2 style="margin:0 0 8px">Thank you, ' || h(o.customer_name) || '!</h2>'
    || '<p>We''ve received your order <b>' || o.order_number || '</b>'
    || case when p_event = 'paid' then ' and your payment.' else '. You''ll pay when it arrives.' end || '</p>'
    || summary
    || '<p>You can track it anytime on our website (Track Your Order) with your order number and email.</p>'
    || '<p>Questions? WhatsApp us at +92 314 1385681.</p><p>— Velanzo</p></div>');

  -- Team alert
  select * into s from email_alert_settings where id = 1;
  if found then
    perform send_brevo_email(
      (select jsonb_agg(jsonb_build_object('email', r)) from unnest(s.recipients) r),
      case when p_event = 'paid' then 'PAID card order ' else 'New COD order ' end || o.order_number || ' — PKR ' || to_char(o.total, 'FM999,999,999'),
      '<div style="font-family:Arial,sans-serif;font-size:14px">'
      || '<p><b>' || case when p_event = 'paid' then 'Card payment received' else 'New Cash on Delivery order' end || '</b> — ' || o.order_number || '</p>'
      || '<p>' || h(o.customer_name) || ' · ' || h(o.email) || '</p>' || summary
      || '<p>Open Admin &rarr; Orders to process it.</p></div>',
      o.email);
  end if;
end $$;
revoke all on function notify_order(uuid, text) from public, anon, authenticated;
grant execute on function notify_order(uuid, text) to service_role;

-- ---------- place_order: shipping + payment method ----------
drop function if exists place_order(text, text, text, text, text, jsonb);
create or replace function place_order(
  p_name text, p_email text, p_phone text, p_address text, p_city text, p_items jsonb,
  p_payment text default 'cod'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order_id uuid;
  v_order_number text;
  v_subtotal integer := 0;
  v_shipping integer;
  v_item jsonb;
  v_product products%rowtype;
  v_qty int;
  v_method text := case when p_payment = 'card' then 'card' else 'cod' end;
begin
  if p_name is null or length(trim(p_name)) < 2 then raise exception 'Please enter your name.'; end if;
  if p_email is null or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Please enter a valid email.'; end if;
  if p_phone is null or length(regexp_replace(p_phone, '\D', '', 'g')) < 10 then raise exception 'Please enter a valid phone number.'; end if;
  if p_address is null or length(trim(p_address)) < 5 then raise exception 'Please enter a delivery address.'; end if;
  if p_city is null or length(trim(p_city)) < 2 then raise exception 'Please choose your city.'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Your bag is empty.'; end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'Too many items in one order.'; end if;

  perform hit_rate_limit('order:ip:' || client_ip(), 10, interval '1 hour');
  perform hit_rate_limit('order:email:' || lower(trim(p_email)), 5, interval '1 hour');
  perform hit_rate_limit('order:global', 500, interval '1 hour');

  v_order_number := 'VZ-' || upper(substring(md5(random()::text || clock_timestamp()::text), 1, 8));
  v_shipping := shipping_fee_for(p_city);

  insert into orders (order_number, customer_name, email, phone, address, city, user_id, payment_method, shipping_fee)
  values (v_order_number, trim(p_name), lower(trim(p_email)),
          left(trim(p_phone), 40), left(trim(p_address), 500), left(trim(p_city), 100),
          auth.uid(), v_method, v_shipping)
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from products where id = (v_item->>'id')::uuid and active and not sold_out;
    if not found then raise exception 'A product in your bag is sold out or no longer available.'; end if;
    v_qty := coalesce((v_item->>'qty')::int, 1);
    if v_qty < 1 or v_qty > 20 then raise exception 'Invalid quantity.'; end if;
    v_subtotal := v_subtotal + v_product.price * v_qty;
    insert into order_items (order_id, product_id, name, price, color, size, qty, image)
    values (v_order_id, v_product.id, v_product.name, v_product.price,
            coalesce(left(v_item->>'color', 40), ''), coalesce(left(v_item->>'size', 20), ''),
            v_qty, coalesce(v_product.images->>0, ''));
  end loop;

  update orders set total = v_subtotal + v_shipping where id = v_order_id;

  -- COD is confirmed now; card orders are confirmed by the Safepay webhook.
  if v_method = 'cod' then perform notify_order(v_order_id, 'placed'); end if;

  return jsonb_build_object('order_number', v_order_number, 'total', v_subtotal + v_shipping,
                            'shipping', v_shipping, 'payment_method', v_method);
end $$;
grant execute on function place_order(text, text, text, text, text, jsonb, text) to anon, authenticated;

-- ---------- track_order: expose payment info ----------
create or replace function track_order(p_order_number text, p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order orders%rowtype;
  v_items jsonb;
begin
  perform hit_rate_limit('track:ip:' || client_ip(), 30, interval '10 minutes');

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
    'shipping', v_order.shipping_fee,
    'payment_method', v_order.payment_method,
    'paid', v_order.paid,
    'customer_name', v_order.customer_name,
    'city', v_order.city,
    'placed_at', v_order.created_at,
    'updated_at', v_order.updated_at,
    'items', v_items);
end $$;
