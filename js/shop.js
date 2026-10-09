'use strict';

(async () => {
  const { el, loadStore, card } = window.Miras;
  const grid = document.getElementById('grid');
  const filters = document.getElementById('filters');
  const count = document.getElementById('count');

  try {
    const store = await loadStore('data/store.json');
    const params = new URLSearchParams(location.search);
    let category = params.get('category') || '';
    let collection = params.get('collection') || '';
    if (!store.categories.some((c) => c.id === category)) category = '';
    if (!store.collections.some((c) => c.id === collection)) collection = '';

    const href = (cat, col) => {
      const q = new URLSearchParams();
      if (cat) q.set('category', cat);
      if (col) q.set('collection', col);
      const s = q.toString();
      return s ? `shop.html?${s}` : 'shop.html';
    };

    function row(label, options, active, makeHref) {
      const wrap = el('div', 'filter-row');
      wrap.append(el('span', 'filter-label', label));
      const nav = el('nav', 'chips');
      nav.setAttribute('aria-label', label);
      for (const [id, name] of [['', 'All'], ...options]) {
        const a = el('a', '', name);
        a.href = makeHref(id);
        if (id === active) a.setAttribute('aria-current', 'true');
        nav.append(a);
      }
      wrap.append(nav);
      return wrap;
    }

    filters.append(
      row('Category', store.categories.map((c) => [c.id, c.name]), category, (id) => href(id, collection)),
      row('Collection', store.collections.map((c) => [c.id, c.title]), collection, (id) => href(category, id)),
    );

    const byId = new Map(store.products.map((p) => [p.id, p]));
    let items = store.products;
    if (collection) {
      const col = store.collections.find((c) => c.id === collection);
      items = col.productIds.map((id) => byId.get(id)).filter(Boolean); // порядок как в админке
    }
    if (category) items = items.filter((p) => p.categoryId === category);

    const cards = items.map((p) => card(p, store)).filter(Boolean);
    count.textContent = `${cards.length} ${cards.length === 1 ? 'item' : 'items'}`;
    if (cards.length) {
      grid.append(...cards);
    } else {
      const li = el('li', 'state', 'Nothing here yet. ');
      const clear = el('a', 'more', 'Clear filters');
      clear.href = 'shop.html';
      li.append(clear);
      grid.append(li);
    }
  } catch (err) {
    console.error(err);
    grid.append(el('li', 'state', 'Could not load products. Please try again later.'));
  }
})();
