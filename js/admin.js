'use strict';

(() => {
  const { normalizeStore, loadStore, httpsUrl, imageSrc } = window.Miras;
  const $ = (selector) => document.querySelector(selector);

  const DRAFT_KEY = 'miras.admin.draft.v1';
  const CFG_KEY = 'miras.admin.github.v1';
  const TOKEN_KEY = 'miras.admin.token.v1';
  const PENDING_KEY = 'miras.admin.photos.v1';
  const MAX_SIDE = 1200;
  const PHOTO_PATH = /^img\/products\/[\w.-]+\.(webp|jpg)$/;

  let state = { categories: [], collections: [], products: [] };
  let dirty = false;
  let editingId = null;
  let formCols = new Set();
  const openCols = new Set();
  let pending = {};          // path -> dataURL: загруженные фото, которые уйдут в репозиторий при Publish
  const uploaded = new Set(); // уже опубликованные в этой сессии (повторно не отправляем)
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
    img.src = pending[product.image] || imageSrc(product.image, '../') || '../img/placeholder.svg';
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

  /* ---------- photos & Amazon paste ---------- */
  function persistPending() {
    const keep = Object.fromEntries(Object.entries(pending).filter(([path]) => !uploaded.has(path)));
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(keep)); } catch {
      toast('Browser storage is full: publish soon, otherwise this photo is lost on reload.', true);
    }
  }

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
    let url = canvas.toDataURL('image/webp', 0.86);
    if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', 0.88); // Safari без WebP-энкодера
    return url;
  }

  function updatePreview() {
    const value = $('#f-image').value.trim();
    const src = pending[value] || imageSrc(value, '../');
    const img = $('#preview');
    if (!src) { img.hidden = true; img.removeAttribute('src'); return; }
    img.hidden = false;
    img.src = src;
  }

  async function handlePhoto(file) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast('Please choose a JPEG, PNG or WebP photo.', true); return; }
    try {
      const dataUrl = await compressImage(file);
      const ext = dataUrl.startsWith('data:image/webp') ? 'webp' : 'jpg';
      const path = `img/products/${Date.now().toString(36)}-${rid()}.${ext}`;
      pending[path] = dataUrl;
      persistPending();
      $('#f-image').value = path;
      updatePreview();
    } catch {
      toast('Could not read this image.', true);
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
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('is-over'); handlePhoto(e.dataTransfer?.files?.[0]); });
  $('#preview').addEventListener('error', () => { $('#preview').hidden = true; });

  /* ---------- state ---------- */
  function persist() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ data: state, dirty })); } catch { /* приватный режим */ }
  }

  function commit() {
    dirty = true;
    persist();
    renderAll();
  }

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
    if (image && !imageSrc(image)) { error.textContent = 'Image must be an https:// link or a path such as img/products/shirt.jpg.'; return; }
    if (!httpsUrl(url)) { error.textContent = 'Amazon link must be a full https:// address.'; return; }
    error.textContent = '';

    let product;
    if (editingId) {
      product = findById(state.products, editingId);
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

  /* ---------- publish / backup ---------- */
  const exportText = () => `${JSON.stringify(state, null, 2)}\n`;

  $('#download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([exportText()], { type: 'application/json' }));
    const a = h('a', { href: url, download: 'store.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const photos = Object.keys(pending).filter((path) => !uploaded.has(path) && state.products.some((p) => p.image === path)).length;
    if (photos) toast(`${plural(photos, 'uploaded photo')} not included: photos are saved to the site only when you Publish.`, true);
  });

  $('#import').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      const imported = normalizeStore(JSON.parse(await file.text()));
      if (!window.confirm(`Replace the current data with this file (${plural(imported.products.length, 'product')})?`)) return;
      state = imported;
      resetForm();
      commit();
      toast('File imported');
    } catch {
      toast('This file is not a valid store.json', true);
    }
  });

  const toBase64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };

  async function githubError(res) {
    let message = '';
    try { message = (await res.json()).message || ''; } catch { /* не JSON */ }
    const hint = [401, 403, 404].includes(res.status)
      ? ' Check the repository name, that the branch exists, and that the token has "Contents: Read and write" for this repo.' : '';
    return `GitHub ${res.status}: ${message || 'request failed'}.${hint}`;
  }

  // Один коммит на всё: store.json + новые фото (Git Data API). Vercel запускает одну сборку, а не N.
  async function commitToGithub({ repo, branch, token, files, message }) {
    const base = `https://api.github.com/repos/${repo}`;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const call = async (suffix, init = {}) => {
      const res = await fetch(base + suffix, {
        ...init,
        headers: init.body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      });
      if (!res.ok) throw new Error(await githubError(res));
      return res.json();
    };
    const ref = branch.split('/').map(encodeURIComponent).join('/');
    const headSha = (await call(`/git/ref/heads/${ref}`)).object.sha;
    const headCommit = await call(`/git/commits/${headSha}`);
    const entries = await Promise.all(files.map(async (file) => {
      const blob = await call('/git/blobs', { method: 'POST', body: JSON.stringify({ content: file.base64, encoding: 'base64' }) });
      return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
    }));
    const tree = await call('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: entries }) });
    const commit = await call('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }) });
    await call(`/git/refs/heads/${ref}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
  }

  $('#publish-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = event.target.elements;
    const error = $('#publish-error');
    const repo = f.repo.value.trim();
    const branch = f.branch.value.trim() || 'main';
    const path = f.path.value.trim().replace(/^\/+/, '') || 'data/store.json';
    const token = f.token.value.trim();

    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { error.textContent = 'Repository must look like owner/repo.'; return; }
    if (!token) { error.textContent = 'Paste a GitHub token.'; return; }
    if (path.split('/').includes('..')) { error.textContent = 'Invalid file path.'; return; }
    error.textContent = '';

    try { localStorage.setItem(CFG_KEY, JSON.stringify({ repo, branch, path })); } catch { /* ignore */ }
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
      if (f.remember.checked) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
    } catch { /* ignore */ }

    const files = [{ path, base64: toBase64(exportText()) }];
    for (const [photoPath, dataUrl] of Object.entries(pending)) {
      if (uploaded.has(photoPath) || !PHOTO_PATH.test(photoPath)) continue;
      if (!state.products.some((p) => p.image === photoPath)) continue; // фото удалённого товара не отправляем
      files.push({ path: photoPath, base64: dataUrl.split(',')[1] });
    }

    const button = $('#publish-btn');
    button.disabled = true;
    button.textContent = 'Publishing…';
    try {
      await commitToGithub({ repo, branch, token, files, message: 'Update store data (admin)' });
      files.slice(1).forEach((file) => uploaded.add(file.path));
      dirty = false;
      persist();
      try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
      renderStatus();
      const n = files.length - 1;
      toast(`Published${n ? ` with ${plural(n, 'photo')}` : ''}. Vercel will redeploy in about a minute.`);
    } catch (err) {
      error.textContent = err.message || 'Could not publish.';
    } finally {
      button.disabled = false;
      button.textContent = 'Publish now';
    }
  });

  /* ---------- chrome ---------- */
  function renderStatus() {
    const node = $('#status');
    node.textContent = dirty ? 'Unpublished changes' : 'Everything is published';
    node.classList.toggle('is-dirty', dirty);
  }

  function renderAll() {
    renderFormOptions();
    renderProducts();
    renderCollections();
    renderCategories();
    renderStatus();
  }

  document.querySelectorAll('.tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === button)));
      document.querySelectorAll('.tab').forEach((tab) => { tab.hidden = tab.id !== `tab-${button.dataset.tab}`; });
    });
  });

  $('#discard').addEventListener('click', () => {
    if (!window.confirm('Discard all unpublished changes made in this browser?')) return;
    try { localStorage.removeItem(DRAFT_KEY); localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
    location.reload();
  });

  async function init() {
    try {
      const cfg = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      const f = $('#publish-form').elements;
      if (cfg) { f.repo.value = cfg.repo || ''; f.branch.value = cfg.branch || 'main'; f.path.value = cfg.path || 'data/store.json'; }
      const remembered = localStorage.getItem(TOKEN_KEY);
      f.token.value = remembered || sessionStorage.getItem(TOKEN_KEY) || '';
      f.remember.checked = Boolean(remembered);
    } catch { /* ignore */ }

    try {
      const saved = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
      for (const [photoPath, dataUrl] of Object.entries(saved)) {
        if (PHOTO_PATH.test(photoPath) && typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) pending[photoPath] = dataUrl;
      }
    } catch { /* ignore */ }

    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* битый черновик */ }

    if (draft && draft.dirty && draft.data) {
      state = normalizeStore(draft.data);
      dirty = true;
      $('#draft-banner').hidden = false;
    } else {
      try {
        state = await loadStore('../data/store.json');
      } catch (err) {
        console.error(err);
        state = normalizeStore({});
        toast('Could not load data/store.json. Starting with an empty store.', true);
      }
    }
    renderAll();
  }

  init();
})();
