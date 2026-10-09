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
(fine-grained, only this repo, "Contents: Read and write"). Publish makes ONE commit with
`data/store.json` + any newly uploaded photos; Vercel redeploys on its own.
No GitHub? Use "Download store.json" and replace the file by hand (uploaded photos are only saved by Publish).

## Adding a product (fast path)
1. On the Amazon product page copy the link from SiteStripe ("Text"). If your account still shows
   "Image" / "Text+Image", copy that code instead.
2. Admin → Products → paste it into "Paste from Amazon": link, title (and photo, if the code has one) are filled in.
3. No photo yet? Drop a file on the Photo box (resized to 1200 px, saved to `img/products/` on Publish)
   or paste an image link.
4. Pick category + collections → Save → Publish.

Amazon does not offer a way to read product photos from a bare link in the browser: the supported
route is the Creators API (replaces PA-API), which needs secret keys and a server.

## Amazon Associates
- Footer disclosure is on every page; replace `ASIN_HERE` / `YOUR_TAG-20` with real SiteStripe links.
- No prices are shown (Amazon requires API-sourced prices with timestamps).
- Images: your own photos in `img/products/` or image links from SiteStripe; do not re-host Amazon images.
