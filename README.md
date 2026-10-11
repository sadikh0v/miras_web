# Miras

Static site (HTML + CSS + JS only) with Supabase as the backend: data, photos and admin login.
Edits in `/admin/` save automatically and go live at once. No deploys, no tokens.

```
index.html, shop.html      public pages
admin/index.html           admin panel (/admin/)
js/config.js               Supabase URL + publishable key  ← fill in
js/common.js               public loader (Supabase → fallback data/store.json)
js/admin.js                admin: sign-in, auto-save, photo upload
supabase/setup.sql         table, access rules (RLS), photo bucket
data/store.json            backup copy shown only if Supabase is unreachable
.github/workflows/keep-alive.yml   optional ping so the free project never sleeps
```

## One-time setup (about 10 minutes)
1. supabase.com → **New project** (region: Frankfurt) → save the DB password.
2. **SQL Editor** → New query → paste `supabase/setup.sql` → **Run**.
3. **Authentication → Users → Add user** (email + password, auto-confirm).
   Then turn **off** new sign-ups (Authentication → Sign In / Providers → "Allow new users to sign up").
4. **Project Settings → API Keys** (or the Connect button): copy the **Project URL** and the
   **publishable key** (`sb_publishable_…`; the legacy `anon` key works too) into `js/config.js`.
   These two values are public by design; security is the RLS rules from step 2.
5. Deploy: `vercel --prod` (or push to GitHub with the repo connected to Vercel).
6. Open `https://YOUR-SITE/admin/` and sign in.

Menu names in the Supabase dashboard change from time to time; look for the same words.

## Daily work
Products tab: paste an Amazon link or SiteStripe code → link/title/photo are filled in; drop a photo
or paste an image link → pick category + collections → Save. The status in the top bar shows
"All changes saved. Live now."

## Good to know
- **Backup tab**: download `store.json` now and then. Commit it as `data/store.json`; the public site
  falls back to it if Supabase is down.
- **Free-tier sleep**: Supabase pauses free projects after about a week without requests. A shop with
  visitors keeps itself awake; otherwise add the keep-alive workflow (repo secrets `SUPABASE_URL`, `SUPABASE_KEY`).
- **Two devices**: saves are version-checked. If the store was changed elsewhere, the admin stops and asks
  you to reload instead of overwriting.
- **Photos** go to the public bucket `products` (max 2 MB, WebP/JPEG/PNG), resized in the browser to 1200 px.
  Photos of deleted or replaced products are removed automatically.

## Amazon Associates
- Footer disclosure is on every page; the shop shows it above the grid too.
- No prices are shown (Amazon requires API-sourced prices with timestamps).
- Use your own photos or image links Amazon gives you; do not re-host Amazon's pictures.
- Fully automatic photos from a bare link need the Amazon Creators API (secret keys + a server).
