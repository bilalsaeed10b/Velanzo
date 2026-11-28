/* ============================================================
   Velanzo Admin - products, categories & orders management.
   Auth + writes go through Supabase; Row Level Security on the
   server decides what an account may do (see supabase/schema.sql).
   ============================================================ */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => 'PKR ' + Number(n || 0).toLocaleString('en-PK');
  const uid = () => 'c-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

  let toastTimer;
  function toast(msg) {
    const el = $('[data-toast]');
    el.textContent = msg;
    el.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-open'), 2600);
  }

  /* ---------- config gate ---------- */
  const cfg = window.LUNA_SUPABASE || {};
  const configured = !!(cfg.url && cfg.anonKey && !String(cfg.url).includes('YOUR-') && !String(cfg.anonKey).includes('YOUR-'));
  $('[data-view="login"]').hidden = false;
  if (!configured) {
    $('[data-setup-note]').innerHTML = `<div class="adm-setup">
      <b>Not connected yet.</b> Follow <code>SETUP.md</code>: create a free Supabase project,
      run <code>supabase/schema.sql</code>, then paste your project URL and anon key into
      <code>assets/js/supabase-config.js</code>.</div>`;
    $('[data-login-form]').style.display = 'none';
    return;
  }
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey);

  const state = {
    tab: 'dashboard',
    inquiries: [],
    inqError: '',
    inqFilter: '',
    inqKind: '',
    products: [],
    categories: [],
    orders: [],
    prodQuery: '',
    orderFilter: '',
    editing: null,     // product being edited (null = new)
    // mains: [{url, colorId}] (gallery slots); variants: [{url, colorId, main}]
    // (a "color image" belonging to main #main). Every image has one colorId;
    // a color is used by at most one image across the whole product.
    gallery: { mains: [], variants: [] },
    uploadTarget: null, // {type:'main'} | {type:'variant', main:i} - where next upload lands
    dragFrom: null,    // index of the main row currently being dragged
  };

  function show(view) {
    $$('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== view; });
  }

  /* ================= AUTH ================= */

  async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return show('login');
    const { data: ok, error } = await sb.rpc('is_admin');
    if (error || !ok) {
      await sb.auth.signOut();
      loginError('This account does not have admin access.');
      return show('login');
    }
    $('[data-admin-email]').textContent = session.user.email;
    show('app');
    await loadAll();
    renderTab();
  }

  function loginError(msg) {
    const el = $('[data-login-error]');
    el.textContent = msg;
    el.hidden = !msg;
  }

  $('[data-login-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError('');
    const btn = $('[data-login-btn]');
    btn.disabled = true; btn.textContent = 'Signing in…';
    const fd = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({
      email: String(fd.get('email')).trim(),
      password: String(fd.get('password')),
    });
    btn.disabled = false; btn.textContent = 'Sign In';
    if (error) return loginError(error.message);
    boot();
  });

  $('[data-logout]').addEventListener('click', async () => {
    await sb.auth.signOut();
    show('login');
  });

  /* ================= DATA ================= */

  async function loadAll() {
    const [p, c, o] = await Promise.all([
      sb.from('products').select('*').order('position').order('created_at', { ascending: false }),
      sb.from('categories').select('*').order('position'),
      sb.from('orders').select('*, order_items(*)').order('created_at', { ascending: false }),
    ]);
    if (p.error || c.error || o.error) {
      toast('Failed to load data: ' + (p.error || c.error || o.error).message);
      return;
    }
    state.products = p.data;
    state.categories = c.data;
    state.orders = o.data;
    const q = await sb.from('inquiries').select('*').order('created_at', { ascending: false }).limit(1000);
    state.inquiries = q.error ? [] : q.data;
    state.inqError = q.error ? 'Inquiries table not found - run supabase/schema5-inquiries-ratelimit.sql.' : '';
    updateInqBadge();
  }

  function updateInqBadge() {
    const n = state.inquiries.filter((i) => i.status === 'new').length;
    const b = $('[data-inq-badge]');
    b.textContent = n; b.hidden = !n;
  }

  /* ================= TABS ================= */

  $$('.adm-nav button').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    $$('.adm-nav button').forEach((x) => x.classList.toggle('is-active', x === b));
    renderTab();
  }));

  function renderTab() {
    $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== state.tab; });
    if (state.tab === 'dashboard') renderDashboard();
    if (state.tab === 'inquiries') renderInquiries();
    if (state.tab === 'products') renderProducts();
    if (state.tab === 'categories') renderCategories();
    if (state.tab === 'orders') renderOrders();
  }

  /* ================= PRODUCTS ================= */

  const catName = (slug) => (state.categories.find((c) => c.slug === slug) || {}).name || slug;

  function renderProducts() {
    const q = state.prodQuery.toLowerCase();
    const list = state.products.filter((p) =>
      !q || (p.name + ' ' + p.category_slug).toLowerCase().includes(q));
    $('[data-prod-count]').textContent = `(${list.length})`;
    $('[data-prod-table]').innerHTML = `
      <tr><th></th><th>Name</th><th>Category</th><th>Price</th><th>Badge</th><th>Status</th><th></th></tr>` +
      list.map((p) => `<tr>
        <td><img class="adm-thumb" src="${esc((p.images || [])[0] || '')}" alt="" loading="lazy"/></td>
        <td><b>${esc(p.name)}</b><br><span class="adm-hint">${esc(p.fit || '')}</span></td>
        <td>${esc(catName(p.category_slug))}</td>
        <td>${money(p.price)}${p.compare_at ? `<br><span class="adm-hint"><s>${money(p.compare_at)}</s></span>` : ''}</td>
        <td>${(p.compare_at && p.compare_at > p.price)
          ? `<span class="adm-tag adm-tag--sale">Sale</span>`
          : (p.badge === 'new' ? `<span class="adm-tag adm-tag--new">New</span>` : '')}</td>
        <td>${p.active ? '' : '<span class="adm-tag adm-tag--off">Hidden</span> '}${p.sold_out || p.stock === 0 ? '<span class="adm-tag">Sold out</span>' : ''}${p.stock != null && p.stock > 0 ? ` <span class="adm-hint">${p.stock} in stock</span>` : ''}</td>
        <td><div class="adm-actions">
          <button class="adm-btn adm-btn--ghost" data-edit="${p.id}">Edit</button>
          <button class="adm-btn adm-btn--danger" data-del="${p.id}">Delete</button>
        </div></td>
      </tr>`).join('');

    $$('[data-edit]').forEach((b) => b.addEventListener('click', () =>
      openEditor(state.products.find((p) => p.id === b.dataset.edit))));
    $$('[data-del]').forEach((b) => b.addEventListener('click', () => deleteProduct(b.dataset.del)));
  }

  $('[data-prod-search]').addEventListener('input', (e) => {
    state.prodQuery = e.target.value;
    renderProducts();
  });

  async function deleteProduct(id) {
    const p = state.products.find((x) => x.id === id);
    if (!confirm(`Delete "${p.name}" permanently?\nTip: untick "Visible in store" instead to just hide it.`)) return;
    const { error } = await sb.from('products').delete().eq('id', id);
    if (error) return toast('Delete failed: ' + error.message);
    state.products = state.products.filter((x) => x.id !== id);
    renderProducts();
    toast('Product deleted');
  }

  /* ---------- editor ---------- */

  const dlg = $('[data-editor]');
  const form = $('[data-editor-form]');

  function editorError(msg) {
    const el = $('[data-editor-error]');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function openEditor(p) {
    state.editing = p || null;
    // Colors carry a stable id so two colors may share a display name.
    const rawColors = p ? (p.colors || []) : [{ name: 'Black', hex: '#1a1a1a' }];
    const colors = rawColors.map((c) => ({ id: c.id || uid(), name: c.name || '', hex: c.hex || '#1a1a1a' }));
    // image_colors[i] "color" is a color id (new) or a color name (legacy) - resolve to an id.
    const toColorId = (v) => {
      if (!v) return '';
      const byId = colors.find((c) => c.id === v);
      if (byId) return byId.id;
      const byName = colors.find((c) => c.name === v);
      return byName ? byName.id : '';
    };
    // Split stored flat arrays into gallery slots (mains) + color images (variants).
    //  {color, main:<int>} = color image of main #main;  {color} = a main photo;
    //  "Name" (string) = legacy color image, paired by order;  null = legacy colorless main.
    const imgs = p ? (p.images || []) : [];
    const ic = p && Array.isArray(p.image_colors) ? p.image_colors : [];
    const mains = [], variants = [], legacySeq = {};
    imgs.forEach((url, i) => {
      const t = ic[i];
      if (typeof t === 'string' && t.trim()) {
        const cid = toColorId(t.trim());
        variants.push({ url, colorId: cid, main: (legacySeq[cid] = (legacySeq[cid] || 0) + 1) - 1 });
      } else if (t && typeof t === 'object' && Number.isInteger(t.main)) {
        variants.push({ url, colorId: toColorId(t.color), main: t.main });
      } else if (t && typeof t === 'object' && t.color) {
        mains.push({ url, colorId: toColorId(t.color) });
      } else {
        mains.push({ url, colorId: '' }); // legacy colorless main
      }
    });
    variants.forEach((v) => { v.main = Math.max(0, Math.min(mains.length - 1, v.main)); });
    state.gallery = { mains, variants };
    state.uploadTarget = null;
    state.dragFrom = null;
    editorError('');
    $('[data-editor-title]').textContent = p ? 'Edit Product' : 'New Product';
    $('[data-cat-select]').innerHTML = state.categories.map((c) =>
      `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('');
    form.name.value = p ? p.name : '';
    form.category_slug.value = p ? p.category_slug : (state.categories[0] || {}).slug || '';
    form.fit.value = p ? (p.fit || '') : '';
    form.dept.value = p ? (p.dept || 'MEN') : 'MEN';
    form.badge.value = p ? (p.badge || '') : '';
    form.price.value = p ? p.price : '';
    form.compare_at.value = p && p.compare_at ? p.compare_at : '';
    form.description.value = p ? (p.description || '') : '';
    form.sizes.value = p ? (p.sizes || []).join(', ') : 'S, M, L, XL, XXL';
    state.sc = scFromSaved(p && p.size_chart);
    renderSizeChart();
    form.active.checked = p ? !!p.active : true;
    form.sold_out.checked = p ? !!p.sold_out : false;
    form.stock.value = p && p.stock != null ? p.stock : '';
    form.position.value = p ? p.position : state.products.length;
    renderColorRows(colors);
    renderImages();
    dlg.showModal();
  }

  $('[data-add-product]').addEventListener('click', () => {
    if (!state.categories.length) return toast('Add a category first');
    openEditor(null);
  });
  $$('[data-editor-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));

  /* size chart: rows of [label, ...values], columns follow the sizes field */
  const scSizes = () => form.sizes.value.split(',').map((s) => s.trim()).filter(Boolean);
  function scFromSaved(sc) {
    if (!sc || !Array.isArray(sc.rows)) return [];
    const heads = (sc.headers || []).slice(1);
    return sc.rows.map((r) => ({ label: r[0] || '', vals: Object.fromEntries(heads.map((h, i) => [h, r[i + 1] || ''])) }));
  }
  function readSizeChart() {
    $$('[data-sc] tr[data-sc-row]').forEach((tr, i) => {
      const row = state.sc[i];
      const ins = tr.querySelectorAll('input');
      row.label = ins[0].value;
      ins.forEach((inp, j) => { if (j) row.vals[inp.dataset.size] = inp.value; });
    });
  }
  function renderSizeChart() {
    const sizes = scSizes();
    $('[data-sc]').innerHTML = !state.sc.length ? '' :
      `<tr><th>Description</th>${sizes.map((s) => `<th>${esc(s)}</th>`).join('')}<td class="adm-sc__del"></td></tr>` +
      state.sc.map((r) => `<tr data-sc-row><td><input value="${esc(r.label)}" maxlength="40" placeholder="e.g. Chest" /></td>${
        sizes.map((s) => `<td><input data-size="${esc(s)}" value="${esc(r.vals[s] || '')}" maxlength="12" /></td>`).join('')
      }<td class="adm-sc__del"><button type="button" data-sc-del title="Remove row">✕</button></td></tr>`).join('');
    $$('[data-sc-del]').forEach((b, i) => b.addEventListener('click', () => {
      readSizeChart(); state.sc.splice(i, 1); renderSizeChart();
    }));
  }
  function sizeChartValue() {
    readSizeChart();
    const sizes = scSizes();
    const rows = state.sc.filter((r) => r.label.trim() || sizes.some((s) => (r.vals[s] || '').trim()))
      .map((r) => [r.label.trim(), ...sizes.map((s) => (r.vals[s] || '').trim())]);
    return rows.length ? { headers: ['Description', ...sizes], rows } : null;
  }
  $('[data-sc-add]').addEventListener('click', () => {
    readSizeChart();
    state.sc.push({ label: '', vals: {} });
    renderSizeChart();
    const ins = $$('[data-sc] tr[data-sc-row]:last-child input');
    if (ins[0]) ins[0].focus();
  });
  form.sizes.addEventListener('input', () => { if (state.sc && state.sc.length) { readSizeChart(); renderSizeChart(); } });

  /* colors */
  function renderColorRows(colors) {
    $('[data-color-rows]').innerHTML = colors.map((c) => colorRowHTML(c)).join('');
    wireColorRows();
  }
  const colorRowHTML = (c) => `<div class="adm-color-row" data-color-id="${esc(c.id || uid())}">
    <input type="color" value="${esc(c.hex || '#1a1a1a')}" />
    <input type="text" value="${esc(c.name || '')}" maxlength="30" placeholder="Color name" />
    <button type="button" class="adm-btn adm-btn--ghost" data-color-del>✕</button>
  </div>`;
  function wireColorRows() {
    $$('[data-color-del]').forEach((b) => b.addEventListener('click', () => {
      b.parentElement.remove();
      renderImages(); // keep per-image color dropdowns in sync
    }));
    $$('.adm-color-row input[type=text]').forEach((inp) => inp.addEventListener('change', renderImages));
  }
  $('[data-add-color]').addEventListener('click', () => {
    $('[data-color-rows]').insertAdjacentHTML('beforeend', colorRowHTML({ id: uid(), name: '', hex: '#1a1a1a' }));
    wireColorRows();
  });
  function readColors() {
    return $$('.adm-color-row').map((row) => ({
      id: row.dataset.colorId,
      hex: row.querySelector('input[type=color]').value,
      name: row.querySelector('input[type=text]').value.trim(),
    })).filter((c) => c.name);
  }

  /* images - one row per gallery slot (main photo). Each slot can have "color
     images" to its right, and every photo (main or color image) picks its color
     from a dropdown. A color already used by any photo is hidden from the other
     dropdowns, so a color maps to exactly one photo. In the store, the swatches
     shown are the colors of the slot you're viewing. Drag a slot by its ⠿ handle
     to reorder. */
  function renderImages() {
    const g = state.gallery;
    const colors = readColors(); // [{id, name, hex}]
    const byId = (id) => colors.find((c) => c.id === id);
    // disambiguate duplicate names in the dropdown, e.g. two "Skin" -> "Skin (1)", "Skin (2)"
    const label = (id) => {
      const c = byId(id); if (!c) return '';
      const same = colors.filter((x) => x.name === c.name);
      return same.length > 1 ? `${c.name} (${same.indexOf(c) + 1})` : c.name;
    };
    const assigned = () => {
      const s = new Set();
      g.mains.forEach((m) => m.colorId && s.add(m.colorId));
      g.variants.forEach((v) => v.colorId && s.add(v.colorId));
      return s;
    };
    // Colors are never auto-assigned - the user picks each photo's color.
    // Only clear a colorId that points at a deleted color, so its dropdown
    // resets to "Pick color…" instead of showing a stale value.
    const dropStale = (o) => { if (o.colorId && !byId(o.colorId)) o.colorId = ''; };
    g.mains.forEach(dropStale); g.variants.forEach(dropStale);
    const optionsFor = (curId) => {
      const used = assigned();
      const avail = colors.filter((c) => c.id === curId || !used.has(c.id));
      return `<option value="" ${curId ? '' : 'selected'} disabled>Pick color…</option>` +
        avail.map((c) => `<option value="${esc(c.id)}" ${c.id === curId ? 'selected' : ''}>${esc(label(c.id))}</option>`).join('');
    };
    $('[data-image-list]').innerHTML = g.mains.map((m, mi) => {
      const vs = g.variants.map((v, vi) => ({ ...v, vi })).filter((v) => v.main === mi);
      return `
      <div class="adm-imgrow" data-row="${mi}">
        <span class="adm-drag" draggable="true" title="Drag to reorder">⠿</span>
        <div class="adm-imgcell">
          <div class="adm-img">
            <img src="${esc(m.url)}" alt="" draggable="false" />
            ${mi === 0 ? '<span class="main-tag">Cover</span>' : ''}
            <button type="button" data-main-del="${mi}" title="Remove photo and its color images">✕</button>
          </div>
          <select class="adm-img-color" data-main-color="${mi}" title="Main photo color">${optionsFor(m.colorId)}</select>
        </div>
        <div class="adm-variants">
          ${vs.map((v) => `
          <div class="adm-imgcell">
            <div class="adm-img adm-img--variant">
              <img src="${esc(v.url)}" alt="" draggable="false" />
              <button type="button" data-variant-del="${v.vi}" title="Remove color image">✕</button>
            </div>
            <select class="adm-img-color" data-variant-color="${v.vi}" title="Color image's color">${optionsFor(v.colorId)}</select>
          </div>`).join('')}
          <button type="button" class="adm-addtile" data-add-variant="${mi}" title="Add a color image for this photo">+</button>
        </div>
      </div>`;
    }).join('') +
    `<button type="button" class="adm-addtile adm-addtile--main" data-add-main>+ ${g.mains.length ? 'Add photo' : 'Upload first photo'}</button>`;

    $('[data-add-main]').addEventListener('click', () => pickFiles({ type: 'main' }));
    $$('[data-add-variant]').forEach((b) => b.addEventListener('click', () =>
      pickFiles({ type: 'variant', main: +b.dataset.addVariant })));
    $$('[data-main-del]').forEach((b) => b.addEventListener('click', () => {
      const mi = +b.dataset.mainDel;
      g.mains.splice(mi, 1);
      g.variants = g.variants.filter((v) => v.main !== mi);
      g.variants.forEach((v) => { if (v.main > mi) v.main--; });
      renderImages();
    }));
    $$('[data-variant-del]').forEach((b) => b.addEventListener('click', () => {
      g.variants.splice(+b.dataset.variantDel, 1);
      renderImages();
    }));
    $$('[data-main-color]').forEach((s) => s.addEventListener('change', () => {
      g.mains[+s.dataset.mainColor].colorId = s.value;
      renderImages(); // re-render so this color drops out of the other dropdowns
    }));
    $$('[data-variant-color]').forEach((s) => s.addEventListener('change', () => {
      g.variants[+s.dataset.variantColor].colorId = s.value;
      renderImages();
    }));
    // drag by the handle only, so the color dropdowns stay clickable
    $$('.adm-drag').forEach((h) => {
      const row = h.closest('.adm-imgrow');
      h.addEventListener('dragstart', (e) => {
        state.dragFrom = +row.dataset.row;
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('is-dragging');
      });
      h.addEventListener('dragend', () => { row.classList.remove('is-dragging'); state.dragFrom = null; });
    });
    $$('.adm-imgrow').forEach((row) => {
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('is-drop'); });
      row.addEventListener('dragleave', () => row.classList.remove('is-drop'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('is-drop');
        const to = +row.dataset.row, from = state.dragFrom;
        if (from === null || from === to) return;
        const [m] = g.mains.splice(from, 1);
        g.mains.splice(to, 0, m);
        // keep each color image attached to its slot as slots shift
        g.variants.forEach((v) => {
          if (v.main === from) v.main = to;
          else if (from < to && v.main > from && v.main <= to) v.main--;
          else if (from > to && v.main >= to && v.main < from) v.main++;
        });
        renderImages();
      });
    });
  }

  function pickFiles(target) {
    state.uploadTarget = target;
    $('[data-image-input]').click();
  }

  $('[data-image-input]').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const target = state.uploadTarget || { type: 'main' };
    state.uploadTarget = null;
    if (!files.length) return;
    const status = $('[data-upload-status]');
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > 5 * 1024 * 1024) { toast(`${file.name}: over 5 MB, skipped`); continue; }
      status.textContent = `Uploading ${i + 1}/${files.length}…`;
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `products/${crypto.randomUUID()}.${ext}`;
      const { error } = await sb.storage.from('product-images').upload(path, file, { cacheControl: '31536000' });
      if (error) { toast(`Upload failed: ${error.message}`); continue; }
      const { data } = sb.storage.from('product-images').getPublicUrl(path);
      // No color yet - the user picks it from the dropdown (no auto-assign).
      if (target.type === 'variant') state.gallery.variants.push({ url: data.publicUrl, colorId: '', main: target.main });
      else state.gallery.mains.push({ url: data.publicUrl, colorId: '' });
      renderImages();
    }
    status.textContent = '';
  });

  /* save */
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    editorError('');
    const name = form.name.value.trim();
    const price = parseInt(form.price.value, 10);
    const compareAt = form.compare_at.value ? parseInt(form.compare_at.value, 10) : null;
    const colors = readColors();
    const sizes = form.sizes.value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!name) return editorError('Name is required.');
    if (!(price >= 0)) return editorError('Price is required.');
    if (compareAt !== null && compareAt <= price) return editorError('Compare-at price must be higher than the price.');
    if (!colors.length) return editorError('Add at least one color (with a name).');
    if (!sizes.length) return editorError('Add at least one size.');
    const g = state.gallery;
    const ids = new Set(colors.map((c) => c.id));
    const nameOf = (id) => (colors.find((c) => c.id === id) || {}).name || id;
    if (!g.mains.length) return editorError('Upload at least one photo.');
    const all = [...g.mains, ...g.variants];
    if (all.some((x) => !x.colorId)) return editorError('Pick a color for every photo and color image.');
    if (all.some((x) => !ids.has(x.colorId))) return editorError('A photo uses a color that was removed - re-pick it.');
    const seen = new Set();
    const dup = all.find((x) => seen.has(x.colorId) || (seen.add(x.colorId), false));
    if (dup) return editorError(`Two photos share the color "${nameOf(dup.colorId)}". Each color can be used by one photo only.`);

    const row = {
      name,
      category_slug: form.category_slug.value,
      fit: form.fit.value.trim(),
      dept: form.dept.value.trim() || 'MEN',
      badge: form.badge.value || null,
      price,
      compare_at: compareAt,
      description: form.description.value.trim(),
      sizes,
      size_chart: sizeChartValue(),
      colors, // [{id, name, hex}]
      images: [...g.mains.map((m) => m.url), ...g.variants.map((v) => v.url)],
      // mains store { color:<colorId> }; color images store { color:<colorId>, main:<slotIndex> }
      image_colors: [...g.mains.map((m) => ({ color: m.colorId })), ...g.variants.map((v) => ({ color: v.colorId, main: v.main }))],
      active: form.active.checked,
      sold_out: form.sold_out.checked,
      stock: form.stock.value === '' ? null : Math.max(0, parseInt(form.stock.value, 10) || 0),
      position: parseInt(form.position.value, 10) || 0,
    };

    const btn = $('[data-editor-save]');
    btn.disabled = true; btn.textContent = 'Saving…';
    const save = (r) => state.editing
      ? sb.from('products').update(r).eq('id', state.editing.id).select().single()
      : sb.from('products').insert(r).select().single();
    let { data, error } = await save(row);
    if (error && /stock/i.test(error.message)) {
      btn.disabled = false; btn.textContent = 'Save Product';
      return editorError('Stock needs a one-time database update: run supabase/schema12-stock.sql in the Supabase SQL Editor, then save again.');
    }
    if (error && /size_chart/i.test(error.message)) {
      btn.disabled = false; btn.textContent = 'Save Product';
      return editorError('Size charts need a one-time database update: run supabase/schema11-size-chart.sql in the Supabase SQL Editor, then save again.');
    }
    if (error && /image_colors/i.test(error.message)) {
      // DB migration schema4-image-colors.sql not run yet. Every image now
      // carries a color, so we can't save without the column - block clearly.
      btn.disabled = false; btn.textContent = 'Save Product';
      return editorError('Image colors need a one-time database update: run supabase/schema4-image-colors.sql in the Supabase SQL Editor, then save again.');
    }
    btn.disabled = false; btn.textContent = 'Save Product';
    if (error) return editorError('Save failed: ' + error.message);

    if (state.editing) {
      const i = state.products.findIndex((p) => p.id === data.id);
      if (i > -1) state.products[i] = data;
    } else {
      state.products.unshift(data);
    }
    dlg.close();
    renderProducts();
    toast(state.editing ? 'Product updated' : 'Product added');
  });

  /* ================= CATEGORIES ================= */

  const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  function renderCategories() {
    const counts = {};
    state.products.forEach((p) => { counts[p.category_slug] = (counts[p.category_slug] || 0) + 1; });
    $('[data-cat-table]').innerHTML = `
      <tr><th>Name</th><th>Slug</th><th>Products</th><th>Position</th><th></th></tr>` +
      state.categories.map((c) => `<tr>
        <td><b>${esc(c.name)}</b></td>
        <td class="adm-hint">${esc(c.slug)}</td>
        <td>${counts[c.slug] || 0}</td>
        <td>${c.position}</td>
        <td><div class="adm-actions">
          <button class="adm-btn adm-btn--ghost" data-cat-edit="${c.id}">Rename</button>
          <button class="adm-btn adm-btn--danger" data-cat-del="${c.id}">Delete</button>
        </div></td>
      </tr>`).join('');

    $$('[data-cat-edit]').forEach((b) => b.addEventListener('click', async () => {
      const c = state.categories.find((x) => x.id === b.dataset.catEdit);
      const name = prompt('Category name:', c.name);
      if (!name || name.trim() === c.name) return;
      const { error } = await sb.from('categories').update({ name: name.trim() }).eq('id', c.id);
      if (error) return toast('Rename failed: ' + error.message);
      c.name = name.trim();
      renderCategories();
      toast('Category renamed');
    }));

    $$('[data-cat-del]').forEach((b) => b.addEventListener('click', async () => {
      const c = state.categories.find((x) => x.id === b.dataset.catDel);
      const n = counts[c.slug] || 0;
      if (n > 0) return toast(`Move or delete the ${n} product(s) in "${c.name}" first.`);
      if (!confirm(`Delete category "${c.name}"?`)) return;
      const { error } = await sb.from('categories').delete().eq('id', c.id);
      if (error) return toast('Delete failed: ' + error.message);
      state.categories = state.categories.filter((x) => x.id !== c.id);
      renderCategories();
      toast('Category deleted');
    }));
  }

  $('[data-cat-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').trim();
    if (!name) return;
    const slug = slugify(name);
    if (!slug || slug === 'all') return toast('That name is not allowed.');
    if (state.categories.some((c) => c.slug === slug)) return toast('That category already exists.');
    const position = state.categories.length;
    const { data, error } = await sb.from('categories').insert({ slug, name, position }).select().single();
    if (error) return toast('Add failed: ' + error.message);
    state.categories.push(data);
    e.target.reset();
    renderCategories();
    toast('Category added');
  });

  /* ================= ORDERS ================= */

  const STATUSES = ['pending', 'delivered', 'cancelled'];

  function renderOrders() {
    const list = state.orders.filter((o) => !state.orderFilter || o.status === state.orderFilter);
    $('[data-order-count]').textContent = `(${list.length})`;
    if (!list.length) {
      $('[data-order-table]').innerHTML = '<tr><td class="adm-hint" style="padding:1.4rem">No orders yet.</td></tr>';
      return;
    }
    $('[data-order-table]').innerHTML = `
      <tr><th>Order</th><th>Date</th><th>Customer</th><th>City</th><th>Items</th><th>Total</th><th>Paid</th><th>Status</th><th></th></tr>` +
      list.map((o) => {
        const items = o.order_items || [];
        return `<tr>
        <td><b>${esc(o.order_number)}</b></td>
        <td>${new Date(o.created_at).toLocaleDateString()}</td>
        <td>${esc(o.customer_name)}</td>
        <td>${esc(o.city || '-')}</td>
        <td>${items.reduce((n, i) => n + i.qty, 0)}</td>
        <td>${money(o.total)}<br><span class="adm-tag ${o.payment_method === 'card' ? 'adm-tag--new' : ''}">${o.payment_method === 'card' ? 'Card' : 'COD'}</span>${o.shipping_fee ? `<span class="adm-hint"> +${money(o.shipping_fee)} ship</span>` : ''}</td>
        <td><label class="adm-paid"><input type="checkbox" data-paid="${o.id}" ${o.paid ? 'checked' : ''} /> ${o.paid ? 'Paid' : 'Unpaid'}</label></td>
        <td><select class="adm-select adm-status adm-status--${o.status}" data-status="${o.id}">
          ${(STATUSES.includes(o.status) ? STATUSES : [o.status, ...STATUSES]).map((s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
        </select></td>
        <td><div class="adm-actions">
          <button class="adm-btn adm-btn--ghost" data-order-open="${o.id}">Details</button>
          <button class="adm-btn adm-btn--danger" data-order-del="${o.id}">Delete</button>
        </div></td>
      </tr>
      <tr class="adm-order-detail" data-order-detail="${o.id}" hidden><td colspan="9"><div class="inner">
        <div>
          <span class="adm-label">Items</span>
          ${items.map((it) => `<div class="adm-order-item">
            ${it.image ? `<img src="${esc(it.image)}" alt=""/>` : ''}
            <div style="flex:1">${esc(it.name)}<br><span class="adm-hint">${esc([it.size, it.color].filter(Boolean).join(' · '))} × ${it.qty}</span></div>
            <div>${money(it.price * it.qty)}</div>
          </div>`).join('')}
        </div>
        <div>
          <span class="adm-label">Delivery</span>
          <p style="margin:.2rem 0">${esc(o.customer_name)}<br>${esc(o.address)}${o.city ? ', ' + esc(o.city) : ''}<br>
          ${esc(o.phone || '')}<br><a href="mailto:${esc(o.email)}">${esc(o.email)}</a></p>
          <span class="adm-hint">Last updated ${new Date(o.updated_at).toLocaleString()}</span>
        </div>
      </div></td></tr>`;
      }).join('');

    $$('[data-order-open]').forEach((b) => b.addEventListener('click', () => {
      const row = $(`[data-order-detail="${b.dataset.orderOpen}"]`);
      row.hidden = !row.hidden;
    }));

    $$('[data-paid]').forEach((cb) => cb.addEventListener('change', async () => {
      const id = cb.dataset.paid;
      const paid = cb.checked;
      const { data, error } = await sb.from('orders').update({ paid }).eq('id', id).select('id');
      if (error || !data.length) {
        cb.checked = !paid;
        return toast('Update failed: ' + (error ? (/paid/.test(error.message) ? 'run supabase/schema7-order-paid.sql' : error.message) : 'no permission - sign in again'));
      }
      const o = state.orders.find((x) => x.id === id);
      o.paid = paid;
      cb.parentElement.lastChild.textContent = paid ? ' Paid' : ' Unpaid';
      toast(`Order ${o.order_number} marked ${paid ? 'paid' : 'unpaid'}`);
    }));

    $$('[data-order-del]').forEach((b) => b.addEventListener('click', () => confirmDeleteOrder(b.dataset.orderDel)));

    $$('[data-status]').forEach((sel) => sel.addEventListener('change', async () => {
      const id = sel.dataset.status;
      const status = sel.value;
      const { data, error } = await sb.from('orders').update({ status }).eq('id', id).select('id');
      if (error || !data.length) return toast('Update failed: ' + (error ? error.message : 'no permission - sign in again'));
      const o = state.orders.find((x) => x.id === id);
      o.status = status;
      sel.className = `adm-select adm-status adm-status--${status}`;
      toast(`Order ${o.order_number} → ${status}`);
    }));
  }

  /* delete order: confirm dialog, button unlocks (red) after 5 seconds */
  const delDlg = $('[data-del-order]');
  const delOk = $('[data-del-order-ok]');
  let delTimer = null, delId = null;

  function confirmDeleteOrder(id) {
    const o = state.orders.find((x) => x.id === id);
    if (!o) return;
    delId = id;
    $('[data-del-order-num]').textContent = o.order_number;
    let left = 5;
    delOk.disabled = true;
    delOk.classList.remove('is-armed');
    delOk.textContent = `Delete (${left})`;
    $('[data-del-order-wait]').textContent = 'Please wait 5 seconds before confirming.';
    clearInterval(delTimer);
    delTimer = setInterval(() => {
      left--;
      if (left > 0) { delOk.textContent = `Delete (${left})`; return; }
      clearInterval(delTimer);
      delOk.disabled = false;
      delOk.classList.add('is-armed');
      delOk.textContent = 'Delete Order';
      $('[data-del-order-wait]').textContent = '';
    }, 1000);
    delDlg.showModal();
  }

  delDlg.addEventListener('close', () => { clearInterval(delTimer); delId = null; });
  $('[data-del-order-cancel]').addEventListener('click', () => delDlg.close());

  delOk.addEventListener('click', async () => {
    if (!delId || delOk.disabled) return;
    const id = delId;
    delOk.disabled = true; delOk.textContent = 'Deleting…';
    const { data, error } = await sb.from('orders').delete().eq('id', id).select('id');
    if (error || !data.length) {
      delDlg.close();
      return toast('Delete failed: ' + (error ? error.message : 'no permission - run supabase/schema6-order-delete.sql'));
    }
    const o = state.orders.find((x) => x.id === id);
    state.orders = state.orders.filter((x) => x.id !== id);
    delDlg.close();
    renderOrders();
    toast(`Order ${o ? o.order_number : ''} deleted`);
  });

  $('[data-order-filter]').addEventListener('change', (e) => {
    state.orderFilter = e.target.value;
    renderOrders();
  });

  /* ================= DASHBOARD ================= */

  const DAY = 86400000;
  const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  function renderDashboard() {
    const orders = state.orders;
    const live = orders.filter((o) => o.status !== 'cancelled');
    const now = Date.now();
    const since = (days) => (o) => now - new Date(o.created_at) < days * DAY;
    // Only orders flagged "Paid" count as money received.
    const paidOrders = live.filter((o) => o.paid);
    const revenue = paidOrders.reduce((n, o) => n + (o.total || 0), 0);
    const rev30 = paidOrders.filter(since(30)).reduce((n, o) => n + (o.total || 0), 0);
    const unpaid = live.filter((o) => !o.paid).reduce((n, o) => n + (o.total || 0), 0);
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, orders.filter((o) => o.status === s).length]));
    const newInq = state.inquiries.filter((i) => i.status === 'new').length;
    const quotes30 = state.inquiries.filter((i) => i.kind === 'quotation' && since(30)(i)).length;
    const activeProducts = state.products.filter((p) => p.active).length;
    const soldOut = state.products.filter((p) => p.active && p.sold_out).length;

    // Orders per day, last 14 days (single series).
    const days = [...Array(14)].map((_, k) => {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (13 - k));
      return { d, n: 0, rev: 0 };
    });
    live.forEach((o) => {
      const t = new Date(o.created_at); t.setHours(0, 0, 0, 0);
      const slot = days.find((x) => x.d.getTime() === t.getTime());
      if (slot) { slot.n++; slot.rev += o.total || 0; }
    });
    const max = Math.max(1, ...days.map((x) => x.n));

    // Top products by units sold.
    const units = {};
    live.forEach((o) => (o.order_items || []).forEach((it) => {
      units[it.name] = units[it.name] || { qty: 0, rev: 0 };
      units[it.name].qty += it.qty; units[it.name].rev += it.price * it.qty;
    }));
    const top = Object.entries(units).sort((a, b) => b[1].qty - a[1].qty).slice(0, 5);

    // Recent activity: orders + inquiries merged.
    const activity = [
      ...orders.slice(0, 10).map((o) => ({ t: o.created_at, html: `New order <b>${esc(o.order_number)}</b> from ${esc(o.customer_name)} · ${money(o.total)}` })),
      ...state.inquiries.slice(0, 10).map((i) => ({ t: i.created_at, html: `${i.kind === 'quotation' ? 'Quotation request' : 'Message'} from <b>${esc(i.name)}</b>${i.company ? ' (' + esc(i.company) + ')' : ''}` })),
    ].sort((a, b) => new Date(b.t) - new Date(a.t)).slice(0, 8);

    const tile = (label, value, sub) => `<div class="adm-tile"><span class="adm-tile__label">${label}</span><span class="adm-tile__value">${value}</span>${sub ? `<span class="adm-tile__sub">${sub}</span>` : ''}</div>`;

    $('[data-dash]').innerHTML = `
      <div class="adm-tiles">
        ${tile('Received', money(revenue), `${money(rev30)} last 30 days · ${money(unpaid)} unpaid`)}
        ${tile('Orders', orders.length, `${orders.filter(since(7)).length} in last 7 days`)}
        ${tile('Pending orders', byStatus.pending, `${byStatus.delivered} delivered`)}
        ${tile('Avg. order value', money(paidOrders.length ? Math.round(revenue / paidOrders.length) : 0), `${byStatus.cancelled} cancelled`)}
        ${tile('New inquiries', newInq, `${quotes30} quotation requests in 30 days`)}
        ${tile('Products live', activeProducts, `${soldOut} sold out`)}
      </div>

      <div class="adm-dash-grid">
        <div class="adm-card adm-card--wide">
          <h3>Orders per day <span class="adm-hint">last 14 days</span></h3>
          <div class="adm-bars" role="img" aria-label="Orders per day over the last 14 days">
            ${days.map((x) => `<div class="adm-bar" tabindex="0" data-tip="${fmtDate(x.d)}: ${x.n} order${x.n === 1 ? '' : 's'} · ${money(x.rev)}">
              <span class="adm-bar__fill" style="height:${(x.n / max) * 100}%"></span>
            </div>`).join('')}
          </div>
          <div class="adm-bars__axis"><span>${fmtDate(days[0].d)}</span><span>${fmtDate(days[13].d)}</span></div>
          <details class="adm-hint"><summary>Show as table</summary>
            <table class="adm-table adm-table--mini">${days.map((x) => `<tr><td>${fmtDate(x.d)}</td><td>${x.n}</td><td>${money(x.rev)}</td></tr>`).join('')}</table>
          </details>
        </div>

        <div class="adm-card">
          <h3>Orders by status</h3>
          ${STATUSES.map((s) => `<div class="adm-row"><span class="adm-status--${s}">${s[0].toUpperCase() + s.slice(1)}</span><b>${byStatus[s]}</b></div>`).join('')}
        </div>

        <div class="adm-card">
          <h3>Top products</h3>
          ${top.length ? top.map(([n, v]) => `<div class="adm-row"><span>${esc(n)}</span><b>${v.qty} sold</b></div>`).join('') : '<p class="adm-hint">No sales yet.</p>'}
        </div>

        <div class="adm-card adm-card--wide">
          <h3>Recent activity</h3>
          ${activity.length ? activity.map((a) => `<div class="adm-row"><span>${a.html}</span><span class="adm-hint">${new Date(a.t).toLocaleString()}</span></div>`).join('') : '<p class="adm-hint">Nothing yet.</p>'}
        </div>
      </div>`;
  }

  $('[data-refresh]').addEventListener('click', async () => { await loadAll(); renderTab(); toast('Refreshed'); });

  /* ================= INQUIRIES ================= */

  const INQ_STATUSES = ['new', 'read', 'replied', 'closed'];

  function renderInquiries() {
    const list = state.inquiries.filter((i) =>
      (!state.inqFilter || i.status === state.inqFilter) && (!state.inqKind || i.kind === state.inqKind));
    $('[data-inq-count]').textContent = `(${list.length})`;
    if (!list.length) {
      $('[data-inq-table]').innerHTML = `<tr><td class="adm-hint" style="padding:1.4rem">${esc(state.inqError || 'No inquiries yet.')}</td></tr>`;
      return;
    }
    $('[data-inq-table]').innerHTML = `
      <tr><th>Date</th><th>Type</th><th>From</th><th>Subject</th><th>Status</th><th></th></tr>` +
      list.map((i) => `<tr${i.status === 'new' ? ' class="adm-unread"' : ''}>
        <td>${new Date(i.created_at).toLocaleString()}</td>
        <td><span class="adm-tag ${i.kind === 'quotation' ? 'adm-tag--new' : ''}">${i.kind === 'quotation' ? 'Quotation' : 'Contact'}</span></td>
        <td><b>${esc(i.name)}</b>${i.company ? `<br><span class="adm-hint">${esc(i.company)}</span>` : ''}</td>
        <td>${esc(i.subject || '-')}${i.quantity ? `<br><span class="adm-hint">Qty: ${esc(i.quantity)}</span>` : ''}</td>
        <td><select class="adm-select" data-inq-status="${i.id}">
          ${INQ_STATUSES.map((s) => `<option value="${s}" ${s === i.status ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
        </select></td>
        <td><div class="adm-actions">
          <button class="adm-btn adm-btn--ghost" data-inq-open="${i.id}">View</button>
          <button class="adm-btn adm-btn--danger" data-inq-del="${i.id}">Delete</button>
        </div></td>
      </tr>
      <tr class="adm-order-detail" data-inq-detail="${i.id}" hidden><td colspan="6"><div class="inner">
        <div><span class="adm-label">Message</span><p class="adm-msg">${esc(i.message)}</p></div>
        <div><span class="adm-label">Contact</span>
          <p style="margin:.2rem 0"><a href="mailto:${esc(i.email)}?subject=${encodeURIComponent('Re: ' + (i.subject || 'Your inquiry') + ' - Velanzo')}">${esc(i.email)}</a>
          ${i.phone ? `<br>${esc(i.phone)} · <a href="https://wa.me/${esc(i.phone.replace(/\D/g, ''))}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : ''}</p>
        </div>
      </div></td></tr>`).join('');

    const setStatus = async (id, status) => {
      const { data, error } = await sb.from('inquiries').update({ status }).eq('id', id).select('id');
      if (error || !data.length) { toast('Update failed: ' + (error ? error.message : 'no permission')); return false; }
      state.inquiries.find((x) => x.id === id).status = status;
      updateInqBadge();
      return true;
    };

    $$('[data-inq-open]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.inqOpen;
      const row = $(`[data-inq-detail="${id}"]`);
      row.hidden = !row.hidden;
      const i = state.inquiries.find((x) => x.id === id);
      if (!row.hidden && i.status === 'new' && await setStatus(id, 'read')) {
        $(`[data-inq-status="${id}"]`).value = 'read';
        row.previousElementSibling.classList.remove('adm-unread');
      }
    }));
    $$('[data-inq-status]').forEach((sel) => sel.addEventListener('change', async () => {
      if (await setStatus(sel.dataset.inqStatus, sel.value)) toast('Inquiry → ' + sel.value);
    }));
    $$('[data-inq-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this inquiry permanently?')) return;
      const { error } = await sb.from('inquiries').delete().eq('id', b.dataset.inqDel);
      if (error) return toast('Delete failed: ' + error.message);
      state.inquiries = state.inquiries.filter((x) => x.id !== b.dataset.inqDel);
      updateInqBadge(); renderInquiries(); toast('Inquiry deleted');
    }));
  }

  $('[data-inq-filter]').addEventListener('change', (e) => { state.inqFilter = e.target.value; renderInquiries(); });
  $('[data-inq-kind]').addEventListener('change', (e) => { state.inqKind = e.target.value; renderInquiries(); });

  /* ================= GO ================= */
  boot();
})();
