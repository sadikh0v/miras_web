'use strict';

(() => {
  const { normalizeStore, httpsUrl, imageSrc } = window.Miras;
  const $ = (selector) => document.querySelector(selector);
  const cfg = window.MIRAS_CONFIG || {};

  const SESSION_KEY = 'miras.admin.session.v1';
  const MAX_SIDE = 1200;
  const SAVE_DELAY = 700;

  class AuthError extends Error {}

  /* ======================================================================
     Supabase: обычный fetch, без SDK и сторонних скриптов.
     Права держатся на RLS из supabase/setup.sql: менять данные может только вошедший пользователь.
     ====================================================================== */
  const SB = (() => {
    const url = String(cfg.supabaseUrl || '').replace(/\/+$/, '');
    const key = String(cfg.supabaseKey || '');
    const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) && key.length > 20 && !/YOUR/i.test(url + key);
    const PUBLIC_PREFIX = `${url}/storage/v1/object/public/products/`;
    let session = null;
    let refreshing = null;

    const rid = () => Math.random().toString(36).slice(2, 8);
    const request = (path, init = {}, token) => fetch(url + path, {
      ...init,
      headers: { apikey: key, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
    });

    function setSession(data) {
      session = data ? {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      } : null;
      try {
        if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else localStorage.removeItem(SESSION_KEY);
      } catch { /* приватный режим */ }
    }

    function restore() {
      try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { session = null; }
      if (!session || !session.refresh_token) session = null;
    }

    // Refresh-токен одноразовый: параллельные обновления склеиваем в одно.
    function refresh() {
      if (!session || !session.refresh_token) return Promise.reject(new AuthError('Please sign in again.'));
      refreshing ??= (async () => {
        const res = await request('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }),
        });
        if (!res.ok) { setSession(null); throw new AuthError('Your session expired. Please sign in again.'); }
        setSession(await res.json());
      })().finally(() => { refreshing = null; });
      return refreshing;
    }

    async function call(path, init = {}) {
      if (!session) throw new AuthError('Please sign in.');
      if (session.expires_at - Date.now() / 1000 < 60) await refresh();
      let res = await request(path, init, session.access_token);
      if (res.status === 401) {
        await refresh();
        res = await request(path, init, session.access_token);
      }
      return res;
    }

    async function signIn(email, password) {
      const res = await request('/auth/v1/token?grant_type=password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
      });
      if (res.status === 429) throw new Error('Too many attempts. Wait a minute and try again.');
      if (!res.ok) throw new Error(res.status === 400 || res.status === 401 ? 'Wrong email or password.' : 'Sign-in failed. Try again in a minute.');
      setSession(await res.json());
    }

    async function signOut() {
      try { if (session) await request('/auth/v1/logout', { method: 'POST' }, session.access_token); } catch { /* ignore */ }
      setSession(null);
    }

    async function loadStore() {
      const res = await call('/rest/v1/store?id=eq.1&select=data,rev', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Could not load the store (${res.status}).`);
      const rows = await res.json();
      if (!rows[0]) throw new Error('The store table is empty. Run supabase/setup.sql first.');
      return rows[0];
    }

    // Запись только если rev не изменился: правка с другого устройства не будет молча затёрта.
    async function saveStore(data, rev) {
      const res = await call(`/rest/v1/store?id=eq.1&rev=eq.${Number(rev)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ data, rev: Number(rev) + 1 }),
      });
      if (!res.ok) throw new Error(`Could not save (${res.status}).`);
      const rows = await res.json();
      if (!rows.length) { const err = new Error('conflict'); err.code = 'conflict'; throw err; }
      return rows[0].rev;
    }

    async function uploadPhoto(blob) {
      const name = `${Date.now().toString(36)}-${rid()}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
      const res = await call(`/storage/v1/object/products/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type, 'x-upsert': 'false', 'cache-control': 'max-age=31536000' },
        body: blob,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
      return PUBLIC_PREFIX + name;
    }

    async function deletePhoto(photoUrl) {
      if (!String(photoUrl).startsWith(PUBLIC_PREFIX)) return; // чужие ссылки (Amazon и т.п.) не трогаем
      const name = photoUrl.slice(PUBLIC_PREFIX.length);
      if (!/^[\w.-]+$/.test(name)) return;
      try { await call(`/storage/v1/object/products/${name}`, { method: 'DELETE' }); } catch { /* не критично */ }
    }

    return { configured, restore, signedIn: () => Boolean(session), signIn, signOut, loadStore, saveStore, uploadPhoto, deletePhoto };
  })();

  /* ---------- state ---------- */
  let state = { categories: [], collections: [], products: [] };
  let rev = 0;
  let saveState = 'saved';
  let saveTimer = null;
  let saving = false;
  let saveQueued = false;
  let changeId = 0;
  let conflict = false;
  let editingId = null;
  let formCols = new Set();
  const openCols = new Set();
  const unsavedUploads = new Set(); // фото, загруженные в форме, но ещё не сохранённые в товаре
  const trash = new Set();          // фото удалённых/замещённых товаров: удаляем после успешного сохранения
  let toastTimer;

  /* ---------- helpers ---------- */
  // Весь вывод строится через DOM API и textContent: HTML из данных не исполняется.
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === false || value == null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children);
    return node;
  }

  const findById = (list, id) => list.find((item) => item.id === id);
  const rid = () => Math.random().toString(36).slice(2, 8);
  const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  function makeId(base, list) {
    let id = base;
    while (!id || list.some((x) => x.id === id)) id = `${base || 'item'}-${rid()}`;
    return id;
  }
  const catName = (id) => findById(state.categories, id)?.name || 'No category';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function move(list, index, delta) {
    const j = index + delta;
    if (j < 0 || j >= list.length) return false;
    [list[index], list[j]] = [list[j], list[index]];
    return true;
  }

  function toast(message, isError = false) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.toggle('is-error', isError);
    node.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('is-visible'), 4500);
  }

  function thumb(product) {
    const img = h('img', { alt: '', loading: 'lazy', width: '56', height: '70' });
    img.src = imageSrc(product.image, '../') || '../img/placeholder.svg';
    img.addEventListener('error', () => { img.src = '../img/placeholder.svg'; }, { once: true });
    return img;
  }

  const iconBtn = (label, aria, disabled, onclick) =>
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': aria, title: aria, disabled, onclick }, label);

  function amazonLinkWarning(url) {
    try {
      const u = new URL(url);
      const amazon = /(^|\.)amazon\.[a-z.]+$/i.test(u.hostname);
      if (amazon && !u.searchParams.has('tag')) return 'This Amazon link has no tag= parameter, so you will not earn commission. Copy the link from SiteStripe.';
      if (!amazon && !/(^|\.)(amzn\.to|a\.co)$/i.test(u.hostname)) return 'This does not look like an Amazon link.';
    } catch { /* пустое поле — без предупреждения */ }
    return '';
  }

  /* ---------- auto-save ---------- */
  const STATUS = {
    saved: 'All changes saved. Live now.',
    pending: 'Unsaved changes…',
    saving: 'Saving…',
    error: 'Not saved. Click to retry.',
    conflict: 'Not saved. Reload needed.',
  };

  function setStatus(kind) {
    saveState = kind;
    const node = $('#status');
    node.textContent = STATUS[kind];
    node.dataset.state = kind;
  }

  function flushTrash() {
    for (const photoUrl of [...trash]) {
      trash.delete(photoUrl);
      if (!state.products.some((p) => p.image === photoUrl)) SB.deletePhoto(photoUrl);
    }
  }

  function commit() {
    changeId += 1;
    renderAll();
    if (conflict) return;
    setStatus('pending');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
  }

  async function save() {
    clearTimeout(saveTimer);
    if (conflict) return;
    if (saving) { saveQueued = true; return; }
    saving = true;
    const startedAt = changeId;
    setStatus('saving');
    try {
      rev = await SB.saveStore(state, rev);
      setStatus(startedAt === changeId ? 'saved' : 'pending');
      flushTrash();
    } catch (err) {
      if (err instanceof AuthError) { signedOut(err.message); }
      else if (err.code === 'conflict') { conflict = true; setStatus('conflict'); $('#conflict').hidden = false; }
      else { setStatus('error'); toast(err.message || 'Could not save.', true); }
    } finally {
      saving = false;
      if (saveQueued) { saveQueued = false; save(); }
    }
  }

  $('#status').addEventListener('click', () => { if (saveState === 'error') save(); });
  $('#reload').addEventListener('click', () => window.location.reload());
  window.addEventListener('beforeunload', (e) => {
    if (['pending', 'saving', 'error'].includes(saveState)) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------- photos & Amazon paste ---------- */
  // Фото уменьшается до 1200 px и перекодируется в WebP: сайт остаётся быстрым, EXIF/GPS стираются.
  async function compressImage(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#F8F3E8'; // цвет паспарту: прозрачные PNG не станут чёрными
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    const toBlob = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    let blob = await toBlob('image/webp', 0.86);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.88); // Safari без WebP-энкодера
    if (!blob) throw new Error('Could not encode the image.');
    return blob;
  }

  function updatePreview() {
    const src = imageSrc($('#f-image').value.trim(), '../');
    const img = $('#preview');
    if (!src) { img.hidden = true; img.removeAttribute('src'); return; }
    img.hidden = false;
    img.src = src;
  }

  function discardUnsavedUploads(keep = '') {
    for (const photoUrl of unsavedUploads) if (photoUrl !== keep) SB.deletePhoto(photoUrl);
    unsavedUploads.clear();
  }

  async function handlePhoto(file) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast('Please choose a JPEG, PNG or WebP photo.', true); return; }
    const status = $('#photo-status');
    status.textContent = 'Uploading…';
    try {
      const photoUrl = await SB.uploadPhoto(await compressImage(file));
      discardUnsavedUploads(); // предыдущее несохранённое фото из этой формы больше не нужно
      unsavedUploads.add(photoUrl);
      $('#f-image').value = photoUrl;
      updatePreview();
      status.textContent = 'Photo uploaded.';
    } catch (err) {
      status.textContent = '';
      if (err instanceof AuthError) signedOut(err.message);
      else toast(`Could not upload the photo. ${err.message || ''}`.trim(), true);
    }
  }

  const fixUrl = (v) => {
    const t = String(v || '').trim();
    return t.startsWith('//') ? `https:${t}` : t.replace(/^http:\/\//i, 'https://');
  };

  // Понимает: обычную ссылку (amazon.com/dp/…, amzn.to/…), SiteStripe «Text» (ссылка + название)
  // и «Image» / «Text+Image» (ссылка + картинка), если они есть в вашем аккаунте.
  // HTML разбирается DOMParser'ом: документ «мёртвый», скрипты и картинки не загружаются.
  function parseAmazonPaste(raw) {
    const out = { url: '', image: '', title: '' };
    const text = String(raw || '').trim();
    if (!text) return out;
    if (!/[<>]/.test(text)) {
      out.url = httpsUrl(fixUrl(text.split(/\s+/)[0])) || '';
      return out;
    }
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const link = doc.querySelector('a[href]');
    if (link) {
      out.url = httpsUrl(fixUrl(link.getAttribute('href'))) || '';
      out.title = (link.textContent || '').trim();
    }
    const img = [...doc.querySelectorAll('img[src]')].find((i) => {
      const src = i.getAttribute('src');
      return !/\/e\/ir\b|\bir-[a-z]+\.amazon-adsystem/i.test(src) && i.getAttribute('width') !== '1' && i.getAttribute('height') !== '1';
    });
    if (img) {
      out.image = httpsUrl(fixUrl(img.getAttribute('src'))) || '';
      if (!out.title) out.title = (img.getAttribute('alt') || '').trim();
    }
    out.title = out.title.slice(0, 120);
    return out;
  }

  function applyPaste() {
    const found = parseAmazonPaste($('#paste').value);
    const f = $('#product-form').elements;
    const status = $('#paste-status');
    if (!found.url && !found.image) {
      status.textContent = $('#paste').value.trim() ? 'Nothing recognised. Paste an Amazon link or the SiteStripe code.' : '';
      return;
    }
    const parts = [];
    if (found.url) { f.url.value = found.url; parts.push('link'); $('#form-warn').textContent = amazonLinkWarning(found.url); }
    if (found.image) { f.image.value = found.image; parts.push('photo'); updatePreview(); }
    if (found.title && !f.title.value.trim()) { f.title.value = found.title; parts.push('title'); }
    status.textContent = `Filled in: ${parts.join(', ')}.${found.image ? '' : ' No photo in what you pasted. Upload one or paste an image link below.'}`;
  }

  $('#paste').addEventListener('input', applyPaste);
  $('#f-image').addEventListener('input', updatePreview);
  $('#photo-file').addEventListener('change', (e) => { const file = e.target.files[0]; e.target.value = ''; handlePhoto(file); });
  const dropZone = $('#photo-drop');
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('is-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-over'));
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('is-over'); handlePhoto(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); });
  $('#preview').addEventListener('error', () => { $('#preview').hidden = true; });

  /* ---------- products ---------- */
  function renderFormOptions() {
    const select = $('#f-category');
    const current = select.value;
    select.replaceChildren(
      h('option', { value: '', text: 'No category' }),
      ...state.categories.map((c) => h('option', { value: c.id, text: c.name })),
    );
    select.value = state.categories.some((c) => c.id === current) ? current : '';

    formCols = new Set([...formCols].filter((id) => findById(state.collections, id)));
    $('#form-cols').replaceChildren(...(state.collections.length
      ? state.collections.map((c) => h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', value: c.id, checked: formCols.has(c.id),
          onchange: (e) => { if (e.target.checked) formCols.add(c.id); else formCols.delete(c.id); },
        }), c.title))
      : [h('p', { class: 'muted', text: 'No collections yet. Create some in the Home collections tab.' })]));
  }

  function renderProducts() {
    const q = $('#search').value.trim().toLowerCase();
    const list = state.products.filter((p) => !q || p.title.toLowerCase().includes(q));
    $('#count').textContent = `(${state.products.length})`;

    const rows = list.map((p) => {
      const inCols = state.collections.filter((c) => c.productIds.includes(p.id)).map((c) => c.title);
      return h('li', {},
        thumb(p),
        h('div', {},
          h('div', { class: 'plist__title', text: p.title }),
          h('div', { class: 'plist__meta', text: [catName(p.categoryId), ...inCols].join(' · ') })),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Edit', onclick: () => startEdit(p) }),
          h('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Delete', onclick: () => removeProduct(p) })));
    });
    $('#product-list').replaceChildren(...(rows.length ? rows : [h('li', { class: 'muted', text: q ? 'Nothing found.' : 'No products yet. Add the first one.' })]));
  }

  function resetForm() {
    discardUnsavedUploads();
    editingId = null;
    formCols = new Set();
    $('#product-form').reset();
    $('#form-title').textContent = 'Add product';
    $('#cancel-edit').hidden = true;
    $('#form-error').textContent = '';
    $('#form-warn').textContent = '';
    $('#paste-status').textContent = '';
    updatePreview();
    renderFormOptions();
  }

  function startEdit(product) {
    discardUnsavedUploads();
    editingId = product.id;
    const f = $('#product-form').elements;
    f.title.value = product.title;
    f.description.value = product.description;
    f.image.value = product.image;
    f.url.value = product.url;
    formCols = new Set(state.collections.filter((c) => c.productIds.includes(product.id)).map((c) => c.id));
    renderFormOptions();
    f.category.value = product.categoryId;
    $('#form-title').textContent = 'Edit product';
    $('#cancel-edit').hidden = false;
    $('#form-error').textContent = '';
    $('#form-warn').textContent = amazonLinkWarning(product.url);
    $('#paste-status').textContent = '';
    updatePreview();
    f.title.focus();
    $('#product-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function removeProduct(product) {
    if (!window.confirm(`Delete "${product.title}"? It will also be removed from all collections.`)) return;
    state.products = state.products.filter((p) => p.id !== product.id);
    state.collections.forEach((c) => { c.productIds = c.productIds.filter((id) => id !== product.id); });
    if (product.image) trash.add(product.image);
    if (editingId === product.id) resetForm();
    commit();
    toast('Product deleted');
  }

  $('#product-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const f = event.target.elements;
    const error = $('#form-error');
    const title = f.title.value.trim();
    const description = f.description.value.trim();
    const image = f.image.value.trim();
    const url = f.url.value.trim();

    if (!title || title.length > 120) { error.textContent = 'Title is required (up to 120 characters).'; return; }
    if (description.length > 400) { error.textContent = 'Description is too long (up to 400 characters).'; return; }
    if (image && !imageSrc(image)) { error.textContent = 'Photo must be an uploaded file or an https:// image link.'; return; }
    if (!httpsUrl(url)) { error.textContent = 'Amazon link must be a full https:// address.'; return; }
    error.textContent = '';

    let product;
    if (editingId) {
      product = findById(state.products, editingId);
      if (product.image && product.image !== image) trash.add(product.image); // старое фото удалим после сохранения
      Object.assign(product, { title, description, image, url, categoryId: f.category.value });
    } else {
      product = { id: makeId(`p-${rid()}`, state.products), title, description, image, url, categoryId: f.category.value };
      state.products.unshift(product); // новые товары — первыми
    }
    for (const col of state.collections) {
      const has = col.productIds.includes(product.id);
      const want = formCols.has(col.id);
      if (want && !has) col.productIds.push(product.id);
      if (!want && has) col.productIds = col.productIds.filter((id) => id !== product.id);
    }
    discardUnsavedUploads(image);
    unsavedUploads.clear();
    resetForm();
    commit();
    toast('Product saved');
  });

  $('#cancel-edit').addEventListener('click', resetForm);
  $('#search').addEventListener('input', renderProducts);
  $('#f-url').addEventListener('input', (e) => { $('#form-warn').textContent = amazonLinkWarning(e.target.value.trim()); });

  /* ---------- home collections ---------- */
  function labelled(text, control) {
    return h('label', { class: 'field' }, h('span', { text }), control);
  }

  function renderCollections() {
    const root = $('#collections');
    if (!state.collections.length) {
      root.replaceChildren(h('p', { class: 'muted', text: 'No collections yet.' }));
      return;
    }
    root.replaceChildren(...state.collections.map((col, i) => {
      const available = state.products.filter((p) => !col.productIds.includes(p.id));
      const select = h('select', { 'aria-label': `Add a product to ${col.title}` },
        h('option', { value: '', text: available.length ? 'Choose a product…' : 'All products are already in this collection' }),
        ...available.map((p) => h('option', { value: p.id, text: p.title })));

      const items = col.productIds.map((id, j) => {
        const p = findById(state.products, id);
        if (!p) return null;
        return h('li', {},
          thumb(p),
          h('div', {},
            h('div', { class: 'plist__title', text: p.title }),
            h('div', { class: 'plist__meta', text: catName(p.categoryId) })),
          h('div', { class: 'row-actions' },
            iconBtn('↑', `Move ${p.title} up`, j === 0, () => { if (move(col.productIds, j, -1)) commit(); }),
            iconBtn('↓', `Move ${p.title} down`, j === col.productIds.length - 1, () => { if (move(col.productIds, j, 1)) commit(); }),
            iconBtn('✕', `Remove ${p.title} from collection`, false, () => { col.productIds.splice(j, 1); commit(); })));
      }).filter(Boolean);

      const det = h('details', { class: 'box' },
        h('summary', {}, h('span', { class: 'box__title', text: col.title }), h('span', { class: 'muted', text: plural(col.productIds.length, 'product') })),
        h('div', { class: 'box__body' },
          h('div', { class: 'box__head' },
            labelled('Title', h('input', {
              value: col.title, maxlength: '60',
              onchange: (e) => { const v = e.target.value.trim(); if (!v) { e.target.value = col.title; return; } col.title = v; commit(); },
            })),
            labelled('Subtitle (shown on the home page)', h('input', {
              value: col.subtitle, maxlength: '140',
              onchange: (e) => { col.subtitle = e.target.value.trim(); commit(); },
            })),
            h('div', { class: 'row-actions' },
              iconBtn('↑', `Move collection ${col.title} up`, i === 0, () => { if (move(state.collections, i, -1)) commit(); }),
              iconBtn('↓', `Move collection ${col.title} down`, i === state.collections.length - 1, () => { if (move(state.collections, i, 1)) commit(); }),
              h('button', {
                class: 'btn btn--ghost btn--small', type: 'button', text: 'Delete collection',
                onclick: () => {
                  if (!window.confirm(`Delete the collection "${col.title}"? The products themselves are kept.`)) return;
                  state.collections.splice(i, 1);
                  commit();
                },
              }))),
          h('ul', { class: 'mini' }, ...(items.length ? items : [h('li', { class: 'muted', text: 'No products in this collection yet.' })])),
          h('div', { class: 'add-row' }, select,
            h('button', {
              class: 'btn btn--small', type: 'button', text: 'Add product',
              onclick: () => { if (select.value) { col.productIds.push(select.value); commit(); } },
            }))));
      det.open = openCols.has(col.id);
      det.addEventListener('toggle', () => { if (det.open) openCols.add(col.id); else openCols.delete(col.id); });
      return det;
    }));
  }

  $('#add-collection').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = event.target.elements.title;
    const title = input.value.trim();
    if (!title) return;
    const col = { id: makeId(slug(title) || 'collection', state.collections), title, subtitle: '', productIds: [] };
    state.collections.push(col);
    openCols.add(col.id);
    input.value = '';
    commit();
    toast('Collection added');
  });

  /* ---------- shop categories ---------- */
  function renderCategories() {
    const root = $('#categories');
    if (!state.categories.length) {
      root.replaceChildren(h('li', { class: 'muted', text: 'No categories yet.' }));
      return;
    }
    root.replaceChildren(...state.categories.map((cat, i) => {
      const n = state.products.filter((p) => p.categoryId === cat.id).length;
      return h('li', {},
        h('input', {
          value: cat.name, maxlength: '60', 'aria-label': `Category name: ${cat.name}`,
          onchange: (e) => { const v = e.target.value.trim(); if (!v) { e.target.value = cat.name; return; } cat.name = v; commit(); },
        }),
        h('div', { class: 'row-actions' },
          iconBtn('↑', `Move ${cat.name} up`, i === 0, () => { if (move(state.categories, i, -1)) commit(); }),
          iconBtn('↓', `Move ${cat.name} down`, i === state.categories.length - 1, () => { if (move(state.categories, i, 1)) commit(); }),
          h('button', {
            class: 'btn btn--ghost btn--small', type: 'button', text: 'Delete',
            onclick: () => {
              const note = n ? ` ${plural(n, 'product')} will become uncategorised.` : '';
              if (!window.confirm(`Delete the category "${cat.name}"?${note}`)) return;
              state.products.forEach((p) => { if (p.categoryId === cat.id) p.categoryId = ''; });
              state.categories.splice(i, 1);
              commit();
            },
          })),
        h('div', { class: 'meta', text: plural(n, 'product') }));
    }));
  }

  $('#add-category').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = event.target.elements.name;
    const name = input.value.trim();
    if (!name) return;
    state.categories.push({ id: makeId(slug(name) || 'category', state.categories), name });
    input.value = '';
    commit();
    toast('Category added');
  });

  /* ---------- backup ---------- */
  $('#download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(state, null, 2)}\n`], { type: 'application/json' }));
    const a = h('a', { href: url, download: 'store.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('#import').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      const imported = normalizeStore(JSON.parse(await file.text()));
      if (!window.confirm(`Replace ALL current data with this file (${plural(imported.products.length, 'product')})? This goes live immediately.`)) return;
      state = imported;
      resetForm();
      commit();
      toast('File imported');
    } catch {
      toast('This file is not a valid store.json', true);
    }
  });

  /* ---------- chrome ---------- */
  function renderAll() {
    renderFormOptions();
    renderProducts();
    renderCollections();
    renderCategories();
  }

  document.querySelectorAll('.tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === button)));
      document.querySelectorAll('.tab').forEach((tab) => { tab.hidden = tab.id !== `tab-${button.dataset.tab}`; });
    });
  });

  /* ---------- sign in / out ---------- */
  function showLogin(message = '') {
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#login-error').textContent = message;
  }

  function signedOut(message) {
    clearTimeout(saveTimer);
    state = { categories: [], collections: [], products: [] };
    showLogin(message || 'Please sign in.');
  }

  async function enterApp() {
    const row = await SB.loadStore();
    state = normalizeStore(row.data);
    rev = row.rev;
    conflict = false;
    saving = false;
    saveQueued = false;
    $('#conflict').hidden = true;
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    setStatus('saved');
    renderAll();
  }

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = event.target.elements;
    const error = $('#login-error');
    error.textContent = '';
    if (!f.email.value.trim() || !f.password.value) { error.textContent = 'Enter your email and password.'; return; }
    try {
      await SB.signIn(f.email.value.trim(), f.password.value);
      f.password.value = '';
      await enterApp();
    } catch (err) {
      error.textContent = err.message;
    }
  });

  $('#logout').addEventListener('click', async () => {
    if (['pending', 'saving', 'error'].includes(saveState) && !window.confirm('Some changes are not saved yet. Sign out anyway?')) return;
    await SB.signOut();
    resetForm();
    signedOut('Signed out.');
  });

  async function init() {
    if (!SB.configured) {
      showLogin('Fill in js/config.js with your Supabase project URL and key first.');
      $('#login-form').querySelector('button').disabled = true;
      return;
    }
    SB.restore();
    if (SB.signedIn()) {
      try { await enterApp(); return; } catch (err) {
        showLogin(err.message); // AuthError: «сессия истекла»; иначе — текст ошибки загрузки
        return;
      }
    }
    showLogin();
  }

  init();
})();
