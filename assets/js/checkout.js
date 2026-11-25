/* ============================================================
   Velanzo - Checkout.
   Orders go through the Supabase `place_order` RPC: the server computes
   prices and shipping (client input is never trusted for totals).
   Card payments: the `safepay` Edge Function creates a Safepay checkout
   for the server-side total, and marks the order paid only after
   verifying Safepay's signature.
   ============================================================ */
window.LUNA.onReady(function () {
  const { Store, getProduct, formatPrice } = window.LUNA;
  const root = document.querySelector('[data-checkout]');
  if (!root) return;
  const cfg = window.LUNA_SUPABASE || {};
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SHIPPING_OUT_OF_CITY = 100; // display only - the server applies the real fee
  const shippingFor = (city) => (/karachi/i.test(city || '') ? 0 : SHIPPING_OUT_OF_CITY);

  /* ---------- Safepay helper ---------- */
  async function startCardPayment(orderNumber, email) {
    const r = await fetch(`${cfg.url}/functions/v1/safepay?action=start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: cfg.anonKey, authorization: `Bearer ${cfg.anonKey}` },
      body: JSON.stringify({ order_number: orderNumber, email }),
    });
    const data = await r.json().catch(() => ({}));
    if (data.paid) return showResult(orderNumber, email, 'paid');
    if (!r.ok || !data.url) throw new Error(data.error || 'Could not start card payment. Please try again.');
    window.location.href = data.url;
  }

  /* ---------- Result screens (after placing / returning from Safepay) ---------- */
  function trackLink(o, e) {
    return `track.html?o=${encodeURIComponent(o)}&e=${encodeURIComponent(e)}`;
  }

  async function lookup(orderNumber, email) {
    try {
      return await window.LUNA.api('/rest/v1/rpc/track_order', {
        method: 'POST', body: JSON.stringify({ p_order_number: orderNumber, p_email: email }),
      });
    } catch { return null; }
  }

  async function showResult(orderNumber, email, status) {
    // Re-check with the server: the webhook may have confirmed it already.
    let o = await lookup(orderNumber, email);
    if (status === 'pending') {
      for (let i = 0; i < 4 && o && !o.paid; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        o = await lookup(orderNumber, email);
      }
    }
    if (o && o.paid) status = 'paid';
    const total = o ? `<p style="color:var(--ink-2)">Total: <b>${formatPrice(o.total)}</b>${o.shipping ? ` (incl. ${formatPrice(o.shipping)} shipping)` : ''}</p>` : '';

    let html;
    if (status === 'paid') {
      Store.clearCart();
      html = `<h1 class="sec-title">Payment Received</h1>
        <p style="color:var(--ink-2);margin-top:1rem">Thank you! Your order is confirmed and a receipt has been emailed to you.</p>
        <div class="co-num">${esc(orderNumber)}</div>${total}
        <a class="btn btn--lg" style="margin-top:1.5rem" href="${trackLink(orderNumber, email)}">Track Your Order</a>`;
    } else if (status === 'pending') {
      html = `<h1 class="sec-title">Confirming Payment</h1>
        <p style="color:var(--ink-2);margin-top:1rem">We're waiting for the bank's confirmation for order <b>${esc(orderNumber)}</b>.
        This usually takes a moment - you'll get an email as soon as it's confirmed.</p>${total}
        <a class="btn btn--lg" style="margin-top:1.5rem" href="${trackLink(orderNumber, email)}">Check Order Status</a>`;
    } else {
      html = `<h1 class="sec-title">Payment Not Completed</h1>
        <p style="color:var(--ink-2);margin-top:1rem">Your order <b>${esc(orderNumber)}</b> is saved, but the card payment
        ${status === 'cancelled' ? 'was cancelled' : 'did not go through'}. No money was taken.</p>${total}
        <div style="display:flex;gap:.8rem;justify-content:center;flex-wrap:wrap;margin-top:1.5rem">
          <button class="btn btn--lg" data-retry>Try Payment Again</button>
          <a class="btn btn--outline btn--lg" href="https://wa.me/923141385681?text=${encodeURIComponent('Hi, I need help with order ' + orderNumber)}" target="_blank" rel="noopener noreferrer">Need Help? WhatsApp</a>
        </div>
        <p data-retry-err style="color:var(--sale);margin-top:.8rem"></p>`;
    }
    root.innerHTML = `<div class="co-done">${html}</div>`;
    const retry = root.querySelector('[data-retry]');
    if (retry) retry.addEventListener('click', async () => {
      retry.disabled = true; retry.textContent = 'Redirecting…';
      try { await startCardPayment(orderNumber, email); }
      catch (e) { root.querySelector('[data-retry-err]').textContent = e.message; retry.disabled = false; retry.textContent = 'Try Payment Again'; }
    });
    window.scrollTo({ top: 0 });
  }

  // Returning from Safepay?
  const qp = new URLSearchParams(location.search);
  if (qp.get('done') && qp.get('e')) {
    root.innerHTML = '<div class="co-done"><p style="color:var(--ink-2)">Checking your payment…</p></div>';
    history.replaceState(null, '', 'checkout.html');
    showResult(qp.get('done'), qp.get('e'), qp.get('status') || 'pending');
    return;
  }

  /* ---------- Checkout form ---------- */
  const itemsEl = root.querySelector('[data-co-items]');
  const form = root.querySelector('[data-co-form]');
  const errEl = root.querySelector('[data-co-error]');
  const submitBtn = root.querySelector('[data-co-submit]');
  const citySel = form.querySelector('[data-co-city]');
  const otherWrap = form.querySelector('[data-co-other]');

  const currentCity = () => (citySel.value === '__other' ? form.city_other.value.trim() : citySel.value);
  const payMethod = () => (form.querySelector('input[name=payment]:checked') || {}).value || 'cod';

  function renderSummary() {
    const cart = Store.cart;
    if (!cart.length) {
      root.innerHTML = `<div class="co-done"><h1 class="sec-title">Your bag is empty</h1>
        <a class="btn btn--lg" style="margin-top:1.5rem" href="collection.html?c=all&dept=men">Start Shopping</a></div>`;
      return false;
    }
    itemsEl.innerHTML = cart.map((item) => {
      const p = getProduct(item.id);
      if (!p) return '';
      return `<div class="co-line">
        <img src="${esc(p.images[0])}" alt="" />
        <div style="flex:1">
          <div>${esc(p.name)}</div>
          <small>${esc([item.size, item.color].filter(Boolean).join(' · '))} × ${item.qty}</small>
        </div>
        <div>${formatPrice(p.price * item.qty)}</div>
      </div>`;
    }).join('');
    const sub = Store.subtotal();
    const city = currentCity();
    const ship = city ? shippingFor(city) : 0;
    root.querySelector('[data-co-subtotal]').textContent = formatPrice(sub);
    root.querySelector('[data-co-shipping]').textContent = !city ? '—' : (ship ? formatPrice(ship) : 'Free');
    root.querySelector('[data-co-total]').textContent = formatPrice(sub + ship);
    submitBtn.textContent = payMethod() === 'card' ? 'Continue to Secure Payment' : 'Place Order';
    return true;
  }

  if (!renderSummary()) return;
  window.addEventListener('luna:change', () => { if (Store.cart.length && document.contains(form)) renderSummary(); });
  citySel.addEventListener('change', () => {
    otherWrap.hidden = citySel.value !== '__other';
    if (!otherWrap.hidden) form.city_other.focus();
    renderSummary();
  });
  form.city_other.addEventListener('input', renderSummary);
  form.querySelectorAll('input[name=payment]').forEach((r) => r.addEventListener('change', renderSummary));

  function setCity(city) {
    if (!city) return;
    const opt = [...citySel.options].find((o) => o.value.toLowerCase() === city.toLowerCase());
    if (opt) citySel.value = opt.value;
    else { citySel.value = '__other'; otherWrap.hidden = false; form.city_other.value = city; }
    renderSummary();
  }

  // Signed-in customers get their saved details pre-filled.
  window.LUNA.authReady.then(async (user) => {
    if (!user || !window.LUNA.sb || !document.contains(form)) return;
    if (!form.email.value) form.email.value = user.email || '';
    const { data } = await window.LUNA.sb.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
    if (!data || !document.contains(form)) return;
    if (!form.name.value) form.name.value = data.full_name || '';
    if (!form.phone.value) form.phone.value = data.phone || '';
    if (!form.address.value) form.address.value = data.address || '';
    setCity(data.city);
  });

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.style.display = 'none';

    if (!window.LUNA.live) {
      window.LUNA.toast('Checkout is unavailable right now - please try again later.');
      return;
    }
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const email = String(fd.get('email') || '').trim();
    const phone = String(fd.get('phone') || '').trim();
    const address = String(fd.get('address') || '').trim();
    const city = currentCity();
    const method = payMethod();
    if (name.length < 2) return showError('Please enter your name.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showError('Please enter a valid email.');
    if (phone.replace(/\D/g, '').length < 10) return showError('Please enter a valid phone number.');
    if (address.length < 5) return showError('Please enter a delivery address.');
    if (city.length < 2) return showError('Please enter your city.');

    submitBtn.disabled = true;
    submitBtn.textContent = method === 'card' ? 'Preparing secure payment…' : 'Placing order…';
    try {
      const result = await window.LUNA.api('/rest/v1/rpc/place_order', {
        method: 'POST',
        body: JSON.stringify({
          p_name: name, p_email: email, p_phone: phone, p_address: address, p_city: city,
          p_items: Store.cart.map((i) => ({ id: i.id, size: i.size, color: i.color, qty: i.qty })),
          p_payment: method,
        }),
      });
      Store.clearCart(); // the order now exists server-side; retries pay the same order

      if (method === 'card') {
        try {
          await startCardPayment(result.order_number, email);
        } catch (err) {
          showResult(result.order_number, email, 'failed');
        }
        return;
      }

      root.innerHTML = `<div class="co-done">
        <h1 class="sec-title">Order Placed</h1>
        <p style="color:var(--ink-2);margin-top:1rem">Thank you, ${esc(name)}. A confirmation has been emailed to you. Save your order number:</p>
        <div class="co-num">${esc(result.order_number)}</div>
        <p style="color:var(--ink-2)">Total: <b>${formatPrice(result.total)}</b>${result.shipping ? ` (incl. ${formatPrice(result.shipping)} shipping)` : ''} - Cash on Delivery</p>
        <a class="btn btn--lg" style="margin-top:1.5rem" href="${trackLink(result.order_number, email)}">Track Your Order</a>
      </div>`;
      window.scrollTo({ top: 0 });
    } catch (err) {
      showError(err.message || 'Could not place order. Please try again.');
      submitBtn.disabled = false;
      renderSummary();
    }
  });
});
