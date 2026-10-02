# Page House Points

A tiny points tracker for Page House (Caltech) — *"spe labor levis, et
spe vinum gravis"*. Static site, hosted on GitHub Pages.

## How it works

- **No build step.** Just `index.html` + `style.css` + `app.js`.
- **Shared data** lives in a public, no-login JSON store
  ([jsonblob.com](https://jsonblob.com)) — GitHub Pages can't run a
  server, so this is the "backend." The page polls it every 20s and also
  refetches on focus, so points added by one admin show up for everyone
  else without a manual reload.
- **Admin access** is gated by a single shared passcode (`whosehouse`,
  set in `app.js`'s `ADMIN_CODE`), entered once per browser tab
  (`sessionStorage`). This is a light gate for a fun internal tracker,
  **not real security** — anyone who opens dev tools can see the data
  store's URL and edit it directly, bypassing the code entirely. Don't
  put anything in here you wouldn't want a motivated Pageboy to mess
  with.
- **Boosts/multipliers** (Happy Hour, Beer Room Boost, Excomm Boost,
  whatever an admin names) apply to points *added while they're active* —
  not retroactively. An admin sets a name, a multiplier, who it applies to
  (everyone or one person), and a duration (or "until manually ended").

## One-time setup (already done once for this deployment)

`app.js`'s `BLOB_ID` constant must point at a real jsonblob.com blob
before the site will load. If it's ever empty, reloading the page shows
an "Initialize the board" button — click it once, from any real browser,
and it'll show you the exact line to paste into `app.js`. Commit that and
redeploy; nobody needs to do this again after that.

## Deploying

Push to `main`. GitHub Pages (Settings → Pages → Source: `main` branch,
`/ (root)`) serves it directly — no Actions workflow needed for a plain
static site like this.

## Local preview

Any static file server works, e.g.:

```
python3 -m http.server 8000
```

then open `http://localhost:8000`.
