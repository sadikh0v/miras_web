'use strict';

(async () => {
  const { el, loadStore, card } = window.Miras;
  const root = document.getElementById('sections');
  const PER_SECTION = 4;

  try {
    const store = await loadStore('data/store.json');
    const byId = new Map(store.products.map((p) => [p.id, p]));
    const blocks = [];

    for (const col of store.collections) {
      const items = col.productIds.map((id) => byId.get(id)).filter(Boolean);
      if (!items.length) continue; // пустые коллекции на главной не показываем

      const head = el('div', 'section__head');
      const titles = el('div');
      titles.append(el('h2', 'section__title', col.title));
      if (col.subtitle) titles.append(el('p', 'section__lead', col.subtitle));
      const more = el('a', 'more', 'View all');
      more.href = `shop.html?collection=${encodeURIComponent(col.id)}`;
      head.append(titles, more);

      const grid = el('ul', 'grid');
      grid.append(...items.slice(0, PER_SECTION).map((p) => card(p, store)).filter(Boolean));

      const container = el('div', 'container');
      container.append(head, grid);
      const section = el('section', 'section');
      section.append(container);
      blocks.push(section);
    }

    if (blocks.length) root.append(...blocks);
    else root.append(el('p', 'state', 'The collections are coming soon.'));
  } catch (err) {
    console.error(err);
    root.append(el('p', 'state', 'Could not load products. Please try again later.'));
  }
})();
