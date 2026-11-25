// ============================================================
// Velanzo — Safepay payments (Supabase Edge Function "safepay").
//
//   POST  ?action=start    {order_number, email} -> {url}   (site calls this)
//   GET/POST ?action=return                                  (Safepay redirects here)
//   POST  ?action=webhook                                    (Safepay server -> us)
//
// Secrets (Supabase -> Edge Functions -> Secrets):
//   SAFEPAY_ENV             sandbox | production
//   SAFEPAY_API_KEY         public key  (sec_...)
//   SAFEPAY_SECRET          v1 secret   (verifies the redirect signature)
//   SAFEPAY_WEBHOOK_SECRET  webhook secret
//   SITE_URL                e.g. https://bilalsaeed10b.github.io/Velanzo
//   SAFEPAY_AMOUNT_MULTIPLIER  optional, default 1 (set 100 if Safepay expects paisa)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// IMPORTANT: turn OFF "Enforce JWT verification" for this function —
// Safepay's redirect and webhook can't send a Supabase token.
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const env = (k: string, d = '') => Deno.env.get(k) ?? d;
const ENV = env('SAFEPAY_ENV', 'sandbox');
const API = ENV === 'production' ? 'https://api.getsafepay.com' : 'https://sandbox.api.getsafepay.com';
const CHECKOUT = ENV === 'production' ? 'https://getsafepay.com/checkout/pay' : 'https://sandbox.api.getsafepay.com/checkout/pay';
const SITE = env('SITE_URL').replace(/\/+$/, '');
const MULT = Number(env('SAFEPAY_AMOUNT_MULTIPLIER', '1')) || 1;
const SELF = `${env('SUPABASE_URL')}/functions/v1/safepay`;

const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin': SITE ? new URL(SITE).origin : '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
const redirect = (url: string) => new Response(null, { status: 303, headers: { location: url } });

async function hmacHex(algo: 'SHA-256' | 'SHA-512', secret: string, data: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: algo }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Small in-memory limiter per IP (per function instance).
const hits = new Map<string, { t: number; n: number }>();
function limited(req: Request, max = 10, windowMs = 60_000) {
  const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > windowMs) { hits.set(ip, { t: now, n: 1 }); return false; }
  return ++h.n > max;
}

async function markPaid(orderId: string, ref: string) {
  // Only flips unpaid -> paid once; the email goes out exactly once.
  const { data } = await db.from('orders')
    .update({ paid: true, paid_at: new Date().toISOString(), payment_ref: ref })
    .eq('id', orderId).eq('paid', false).select('id');
  if (data && data.length) await db.rpc('notify_order', { p_order_id: orderId, p_event: 'paid' });
}

async function start(req: Request) {
  if (limited(req)) return json({ error: 'Too many attempts. Please wait a minute.' }, 429);
  const { order_number, email } = await req.json().catch(() => ({}));
  if (!order_number || !email) return json({ error: 'Missing order.' }, 400);

  const { data: o } = await db.from('orders').select('*')
    .eq('order_number', String(order_number).toUpperCase().trim())
    .eq('email', String(email).toLowerCase().trim()).maybeSingle();
  if (!o) return json({ error: 'Order not found.' }, 404);
  if (o.payment_method !== 'card') return json({ error: 'This order is Cash on Delivery.' }, 400);
  if (o.paid) return json({ paid: true });
  if (o.status === 'cancelled') return json({ error: 'This order was cancelled.' }, 400);

  // Amount always comes from the database, never from the browser.
  const r = await fetch(`${API}/order/v1/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: env('SAFEPAY_API_KEY'), amount: o.total * MULT, currency: 'PKR', environment: ENV }),
  });
  const body = await r.json().catch(() => ({}));
  const token = body?.data?.token;
  if (!r.ok || !token) {
    console.error('safepay init failed', r.status, JSON.stringify(body));
    return json({ error: 'Payment service is unavailable. Please try again or choose Cash on Delivery.' }, 502);
  }
  await db.from('orders').update({ payment_ref: token }).eq('id', o.id);

  const back = (status: string) =>
    `${SELF}?action=return&o=${encodeURIComponent(o.order_number)}&e=${encodeURIComponent(o.email)}&s=${status}`;
  const qs = new URLSearchParams({
    beacon: token,
    cancel_url: back('cancelled'),
    env: ENV,
    order_id: o.order_number,
    redirect_url: back('done'),
    source: 'custom',
    webhooks: 'true',
  });
  return json({ url: `${CHECKOUT}?${qs}` });
}

async function handleReturn(req: Request, url: URL) {
  const p = url.searchParams;
  const form: Record<string, string> = {};
  if (req.method === 'POST') {
    const ct = req.headers.get('content-type') || '';
    if (ct.includes('json')) Object.assign(form, await req.json().catch(() => ({})));
    else (await req.formData().catch(() => new FormData())).forEach((v, k) => { form[k] = String(v); });
  }
  const get = (k: string) => form[k] ?? p.get(k) ?? '';
  const orderNo = get('o'), email = get('e');
  const tracker = get('tracker'), sig = get('sig');
  const done = (status: string) =>
    redirect(`${SITE}/checkout.html?done=${encodeURIComponent(orderNo)}&e=${encodeURIComponent(email)}&status=${status}`);

  if (get('s') === 'cancelled') return done('cancelled');

  const { data: o } = await db.from('orders').select('*')
    .eq('order_number', orderNo.toUpperCase()).eq('email', email.toLowerCase()).maybeSingle();
  if (!o) return done('failed');
  if (o.paid) return done('paid');

  // Verify: HMAC-SHA256(tracker, v1 secret) must equal sig, and the tracker
  // must be the one we created for THIS order.
  const expected = tracker ? await hmacHex('SHA-256', env('SAFEPAY_SECRET'), tracker) : '';
  if (tracker && sig && safeEqual(expected, sig) && tracker === o.payment_ref) {
    await markPaid(o.id, tracker);
    return done('paid');
  }
  // Signature missing/unclear: the webhook may still confirm it shortly.
  return done('pending');
}

async function webhook(req: Request) {
  const raw = await req.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ ok: false }, 400); }
  const sig = req.headers.get('x-sfpy-signature') || '';
  const expected = await hmacHex('SHA-512', env('SAFEPAY_WEBHOOK_SECRET'), JSON.stringify(body?.data));
  if (!safeEqual(expected, sig)) return json({ ok: false }, 401);

  const d = body.data || {};
  const tracker = d?.tracker?.token || d?.tracker || d?.token || '';
  const state = String(d?.tracker?.state || d?.state || d?.status || '').toUpperCase();
  const okType = /PAYMENT[._]SUCCEEDED|PAYMENT[._]SUCCESS|CHARGED|PAID/i.test(String(body.type || ''))
    || /PAID|SUCCEEDED|ENDED|CAPTURED|COMPLETED/.test(state);
  if (!tracker || !okType) return json({ ok: true, ignored: true });

  const { data: o } = await db.from('orders').select('id').eq('payment_ref', String(tracker)).maybeSingle();
  if (o) await markPaid(o.id, String(tracker));
  return json({ ok: true });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    switch (url.searchParams.get('action')) {
      case 'start': return await start(req);
      case 'return': return await handleReturn(req, url);
      case 'webhook': return await webhook(req);
      default: return json({ error: 'Unknown action' }, 404);
    }
  } catch (e) {
    console.error(e);
    return json({ error: 'Server error' }, 500);
  }
});
