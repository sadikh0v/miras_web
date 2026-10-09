'use strict';

/* Общий код публичных страниц и админки: загрузка данных, проверка ссылок, карточка товара. */
window.Miras = (() => {
  const PLACEHOLDER = 'img/placeholder.svg';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Любой текст из данных попадает на страницу только через textContent — HTML не исполняется.
  function str(value, max) {
    if (typeof value !== 'string') return '';
    return value.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function httpsUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' ? u.href : null;
    } catch { return null; }
  }

  // Картинка: https-ссылка или путь внутри сайта (img/products/x.jpg). javascript:, data:, // — отклоняются.
  function imageSrc(value, base = '') {
    if (typeof value !== 'string' || !value.trim()) return null;
    const v = value.trim();
    if (/^https:\/\//i.test(v)) return httpsUrl(v);
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//')) return null;
    return v.startsWith('/') ? v : base + v;
  }

  function normalizeStore(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const list = (v) => (Array.isArray(v) ? v : []);
    const uniq = () => {
      const seen = new Set();
      return (id, fallback) => {
        const base = str(id, 40).replace(/[^a-zA-Z0-9_-]/g, '-') || fallback;
        let out = base;
        for (let n = 2; seen.has(out); n++) out = `${base}-${n}`;
        seen.add(out);
        return out;
      };
    };
    const catId = uniq(), colId = uniq(), prodId = uniq();

    const categories = list(data.categories)
      .map((c) => ({ id: catId(c?.id, 'category'), name: str(c?.name, 60) }))
      .filter((c) => c.name);
    const catIds = new Set(categories.map((c) => c.id));

    const products = list(data.products)
      .map((p) => ({
        id: prodId(p?.id, 'product'),
        title: str(p?.title, 120),
        description: str(p?.description, 400),
        image: str(p?.image, 500),
        url: str(p?.url, 800),
        categoryId: str(p?.categoryId, 40),
      }))
      .filter((p) => p.title)
      .map((p) => ({ ...p, categoryId: catIds.has(p.categoryId) ? p.categoryId : '' }));
    const prodIds = new Set(products.map((p) => p.id));

    const collections = list(data.collections)
      .map((c) => ({
        id: colId(c?.id, 'collection'),
        title: str(c?.title, 60),
        subtitle: str(c?.subtitle, 140),
        productIds: [...new Set(list(c?.productIds).filter((id) => prodIds.has(id)))],
      }))
      .filter((c) => c.title);

    return { categories, collections, products };
  }

  async function loadStore(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
    return normalizeStore(await res.json());
  }

  function card(product, store) {
    const href = httpsUrl(product.url);
    if (!href) return null;
    if (/YOUR_TAG|ASIN_HERE/.test(product.url)) console.warn('Placeholder Amazon link, replace it:', product.title);

    const link = el('a', 'card');
    link.href = href;
    link.target = '_blank';
    link.rel = 'sponsored nofollow noopener noreferrer'; // партнёрская ссылка

    const media = el('div', 'card__media');
    const img = el('img');
    img.src = imageSrc(product.image) || PLACEHOLDER;
    img.alt = product.title;
    img.loading = 'lazy';
    img.width = 400;
    img.height = 500;
    img.addEventListener('error', () => { img.src = PLACEHOLDER; }, { once: true });
    media.append(img);

    const body = el('div', 'card__body');
    const cat = store.categories.find((c) => c.id === product.categoryId);
    if (cat) body.append(el('p', 'card__cat', cat.name));
    body.append(el('h3', 'card__title', product.title));
    if (product.description) body.append(el('p', 'card__text', product.description));
    body.append(el('span', 'btn', 'View on Amazon'));

    link.append(media, body);
    const li = el('li');
    li.append(link);
    return li;
  }

  document.querySelectorAll('[data-year]').forEach((n) => { n.textContent = new Date().getFullYear(); });

  return { el, str, httpsUrl, imageSrc, normalizeStore, loadStore, card };
})();
