-- ============================================================
-- Velanzo — Migration 8: WhatsApp alert for every new inquiry.
-- Run ONCE in Supabase SQL Editor (after schema7-order-paid.sql).
--
-- Uses the free CallMeBot WhatsApp API. One-time setup:
--   1. Open callmebot.com/blog/free-api-whatsapp-messages and save the
--      CallMeBot WhatsApp number shown there in your phone's contacts.
--   2. Send it this WhatsApp message:  I allow callmebot to send me messages
--   3. It replies with your API key.
--   4. Put your number + key in the INSERT at the bottom of this file, then Run.
-- The key is stored server-side only (never sent to the website).
-- ============================================================

create extension if not exists pg_net;

create table if not exists alert_settings (
  id int primary key default 1 check (id = 1),
  whatsapp_phone text not null,      -- your number, international format, e.g. +923141385681
  callmebot_key text not null
);
alter table alert_settings enable row level security;  -- no policies: not readable via the API

create or replace function notify_inquiry_whatsapp() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  s alert_settings%rowtype;
  msg text;
begin
  select * into s from alert_settings where id = 1;
  if not found then return new; end if;

  msg := left(
    'New Velanzo ' || case when new.kind = 'quotation' then 'QUOTATION request' else 'message' end || E'\n' ||
    'From: ' || new.name || coalesce(nullif(' (' || new.company || ')', ' ()'), '') || E'\n' ||
    'Email: ' || new.email ||
    coalesce(nullif(E'\nPhone: ' || new.phone, E'\nPhone: '), '') ||
    coalesce(nullif(E'\nQty: ' || new.quantity, E'\nQty: '), '') || E'\n\n' ||
    new.message, 1200);

  perform net.http_get(
    url := 'https://api.callmebot.com/whatsapp.php',
    params := jsonb_build_object('phone', s.whatsapp_phone, 'text', msg, 'apikey', s.callmebot_key));
  return new;
exception when others then
  return new;  -- never block an inquiry because the alert failed
end $$;

drop trigger if exists inquiry_whatsapp on inquiries;
create trigger inquiry_whatsapp after insert on inquiries
  for each row execute function notify_inquiry_whatsapp();

-- >>> EDIT THESE TWO VALUES, then run <<<
insert into alert_settings (id, whatsapp_phone, callmebot_key)
values (1, '+923141385681', 'PASTE-YOUR-CALLMEBOT-KEY')
on conflict (id) do update set whatsapp_phone = excluded.whatsapp_phone,
                               callmebot_key = excluded.callmebot_key;
