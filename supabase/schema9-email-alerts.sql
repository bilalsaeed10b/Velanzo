-- ============================================================
-- Velanzo — Migration 9: email alert for every new inquiry.
-- Run ONCE in Supabase SQL Editor (after schema5-inquiries-ratelimit.sql).
--
-- Uses Brevo (free: 300 emails/day, no domain needed). One-time setup:
--   1. Sign up at brevo.com (free plan).
--   2. Senders, Domains & Dedicated IPs -> Senders -> Add a sender:
--      use one of your Gmail addresses and click the verification link.
--   3. SMTP & API -> API Keys -> Generate a new API key, copy it.
--   4. Fill in the INSERT at the bottom of this file, then Run.
-- The key is stored server-side only (never sent to the website).
-- ============================================================

create extension if not exists pg_net;

create table if not exists email_alert_settings (
  id int primary key default 1 check (id = 1),
  brevo_key text not null,
  sender_email text not null,        -- the sender you verified in Brevo
  recipients text[] not null         -- who receives the alerts
);
alter table email_alert_settings enable row level security;  -- no policies: not readable via the API

create or replace function notify_inquiry_email() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  s email_alert_settings%rowtype;
  esc_msg text;
  subj text;
  html text;
begin
  select * into s from email_alert_settings where id = 1;
  if not found then return new; end if;

  subj := 'New Velanzo ' || case when new.kind = 'quotation' then 'quotation request' else 'message' end
          || ' from ' || new.name;
  esc_msg := replace(replace(replace(new.message, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
  html := '<p><b>' || case when new.kind = 'quotation' then 'Quotation request' else 'Contact message' end || '</b></p>'
       || '<p>Name: ' || replace(replace(new.name, '<', '&lt;'), '>', '&gt;')
       || case when new.company <> '' then '<br>Company: ' || replace(replace(new.company, '<', '&lt;'), '>', '&gt;') else '' end
       || '<br>Email: ' || replace(replace(new.email, '<', '&lt;'), '>', '&gt;')
       || case when new.phone <> '' then '<br>Phone: ' || replace(replace(new.phone, '<', '&lt;'), '>', '&gt;') else '' end
       || case when new.quantity <> '' then '<br>Quantity: ' || replace(replace(new.quantity, '<', '&lt;'), '>', '&gt;') else '' end
       || case when new.subject <> '' then '<br>Subject: ' || replace(replace(new.subject, '<', '&lt;'), '>', '&gt;') else '' end
       || '</p><p style="white-space:pre-wrap">' || esc_msg || '</p>'
       || '<p>Reply to this email to answer the customer, or open Admin &rarr; Inquiries.</p>';

  perform net.http_post(
    url := 'https://api.brevo.com/v3/smtp/email',
    headers := jsonb_build_object('api-key', s.brevo_key, 'content-type', 'application/json', 'accept', 'application/json'),
    body := jsonb_build_object(
      'sender', jsonb_build_object('name', 'Velanzo Website', 'email', s.sender_email),
      'to', (select jsonb_agg(jsonb_build_object('email', r)) from unnest(s.recipients) r),
      'replyTo', jsonb_build_object('email', new.email, 'name', new.name),
      'subject', subj,
      'htmlContent', html));
  return new;
exception when others then
  return new;  -- never block an inquiry because the alert failed
end $$;

drop trigger if exists inquiry_email on inquiries;
create trigger inquiry_email after insert on inquiries
  for each row execute function notify_inquiry_email();

-- >>> EDIT THESE VALUES, then run <<<
insert into email_alert_settings (id, brevo_key, sender_email, recipients)
values (1,
  'PASTE-YOUR-BREVO-API-KEY',
  'SENDER-YOU-VERIFIED@gmail.com',
  array['FIRST-RECIPIENT@gmail.com', 'SECOND-RECIPIENT@gmail.com'])
on conflict (id) do update set brevo_key = excluded.brevo_key,
                               sender_email = excluded.sender_email,
                               recipients = excluded.recipients;
