/* ============================================================
   Velanzo - Inquiries: "Get Quotation" dialog + contact form.
   Submissions go to the submit_inquiry RPC (rate limited server-side)
   and show up in Admin -> Inquiries.
   ============================================================ */
(function () {
  const COOLDOWN_MS = 30000; // client-side spam guard between sends
  const KEY = 'velanzo:lastInquiry';

  function recentlySent() {
    try { return Date.now() - Number(localStorage.getItem(KEY) || 0) < COOLDOWN_MS; } catch { return false; }
  }
  function markSent() { try { localStorage.setItem(KEY, String(Date.now())); } catch {} }

  async function send(payload) {
    const sb = window.LUNA && window.LUNA.sb;
    if (!sb) throw new Error('Messaging is unavailable right now. Please email or WhatsApp us.');
    if (recentlySent()) throw new Error('Please wait a few seconds before sending another message.');
    const { error } = await sb.rpc('submit_inquiry', {
      p_kind: payload.kind, p_name: payload.name || '', p_email: payload.email || '',
      p_phone: payload.phone || '', p_company: payload.company || '', p_quantity: payload.quantity || '',
      p_subject: payload.subject || '', p_message: payload.message || '',
    });
    if (error) throw new Error(error.message);
    markSent();
  }

  const toast = (m) => (window.LUNA && window.LUNA.toast ? window.LUNA.toast(m) : alert(m));

  const DIALOG_HTML = `<dialog class="quote" data-quote>
    <form class="quote__form" data-quote-form>
      <div class="quote__head">
        <h3>Get a Quotation</h3>
        <button type="button" class="iconbtn" data-quote-close aria-label="Close">&times;</button>
      </div>
      <p class="quote__sub">Tell us about your manufacturing or bulk order and we'll get back to you within 24 hours.</p>
      <div class="field"><label class="pdp__label" for="q-name">Name *</label><input class="input" id="q-name" name="name" required maxlength="120" /></div>
      <div class="field"><label class="pdp__label" for="q-email">Email *</label><input class="input" id="q-email" name="email" type="email" required maxlength="200" /></div>
      <div class="field"><label class="pdp__label" for="q-phone">Phone</label><input class="input" id="q-phone" name="phone" maxlength="40" /></div>
      <div class="field"><label class="pdp__label" for="q-company">Company</label><input class="input" id="q-company" name="company" maxlength="120" /></div>
      <div class="field"><label class="pdp__label" for="q-qty">Estimated Quantity</label><input class="input" id="q-qty" name="quantity" maxlength="60" placeholder="e.g. 500 pieces" /></div>
      <div class="field"><label class="pdp__label" for="q-msg">Message *</label><textarea class="textarea" id="q-msg" name="message" required maxlength="4000" placeholder="Product type, fabric, sizes, timeline…"></textarea></div>
      <input type="text" name="website" tabindex="-1" autocomplete="off" class="quote__hp" aria-hidden="true" />
      <p class="quote__err" data-quote-err hidden></p>
      <button class="btn btn--block btn--lg" type="submit" data-quote-send>Send Request</button>
    </form>
  </dialog>`;

  function initQuote() {
    if (!document.querySelector('[data-quote]')) document.body.insertAdjacentHTML('beforeend', DIALOG_HTML);
    const dlg = document.querySelector('[data-quote]');
    const form = dlg.querySelector('[data-quote-form]');
    const err = dlg.querySelector('[data-quote-err]');
    const btn = dlg.querySelector('[data-quote-send]');
    // Delegated: works for buttons rendered later (e.g. the footer link).
    document.addEventListener('click', (e) => {
      const opener = e.target.closest('[data-quote-open]');
      if (!opener) return;
      e.preventDefault();
      err.hidden = true; dlg.showModal();
    });
    dlg.querySelector('[data-quote-close]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(form));
      if (fd.website) return dlg.close(); // honeypot: bots fill hidden field
      err.hidden = true; btn.disabled = true; btn.textContent = 'Sending…';
      try {
        await send({ ...fd, kind: 'quotation', subject: 'Quotation request' });
        form.reset(); dlg.close();
        toast('Request sent - we\'ll reply within 24 hours');
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
      } finally {
        btn.disabled = false; btn.textContent = 'Send Request';
      }
    });
  }

  function initContact() {
    const form = document.querySelector('[data-contact-form]');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        await send({
          kind: 'contact',
          name: form.querySelector('#cf-name').value,
          email: form.querySelector('#cf-email').value,
          subject: form.querySelector('#cf-subject').value,
          message: form.querySelector('#cf-msg').value,
        });
        form.reset();
        toast('Message sent - we\'ll reply within 24 hours');
      } catch (ex) {
        toast(ex.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function boot() { initQuote(); initContact(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
