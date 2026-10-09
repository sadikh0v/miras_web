# Miras

Static site: HTML + CSS + JS only. All content lives in `data/store.json`.

- `index.html` — home: main photo (`img/hero.jpg`) + collections (Seasonal, Top Picks, …)
- `shop.html` — shop with Category and Collection filters
- `admin/index.html` — admin at `/admin/` (products, home collections, shop categories, publish)
- `data/store.json` — categories, collections, products (edited by the admin)

## Deploy
```bash
git init && git add . && git commit -m "Miras"
# push to GitHub, then import the repo in Vercel (no build settings needed)
# or without GitHub:  vercel --prod
```

## Local preview
```bash
npx serve .      # or: python3 -m http.server 3000
```

## Admin → publish
Open `/admin/`, edit, then Publish tab → repository `owner/repo`, branch, GitHub token
(fine-grained, only this repo, "Contents: Read and write"). Publish commits `data/store.json`;
Vercel redeploys on its own. No GitHub? Use "Download store.json" and replace the file by hand.

## Amazon Associates
- Footer disclosure is on every page; replace `ASIN_HERE` / `YOUR_TAG-20` with real SiteStripe links.
- No prices are shown (Amazon requires API-sourced prices with timestamps).
- Images: your own photos in `img/products/` or image links from SiteStripe; do not re-host Amazon images.
