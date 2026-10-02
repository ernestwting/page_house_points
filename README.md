# Page House Points

A tiny points tracker for Page House (Caltech) — *"spe labor levis, et
spe vinum gravis"*. Static site, hosted on GitHub Pages.

## How it works

- **No build step.** Just `index.html` + `style.css` + `app.js`.
- **Shared data** lives in a Google Sheet, fronted by a small Google Apps
  Script Web App (`apps-script/Code.gs`) — GitHub Pages can't run a
  server, so this is the "backend." The page polls it every 20s and also
  refetches on focus, so points added by one admin show up for everyone
  else without a manual reload. (Two no-signup public JSON stores were
  tried first and both turned out unreliable in practice — one blocked
  writes outright, the other had a broken CORS setup — hence Apps Script
  instead, which is free, needs no billing, and is backed by Google's own
  infrastructure.)
- **Admin access** is gated by a single shared passcode (`whosehouse`,
  set in `app.js`'s `ADMIN_CODE`), entered once per browser tab
  (`sessionStorage`). This is a light gate for a fun internal tracker,
  **not real security** — anyone who opens dev tools can see the data
  store's URL and edit it directly, bypassing the code entirely. Don't
  put anything in here you wouldn't want a motivated Pageboy to mess
  with.
- **Each Pageboy has seven scoring categories**, not just one points
  total: Base, Shot O'Clock (a multiplier), Beer Room Boost, 15 for 15,
  Polar Bear (a penalty), Whose House, and Happy Hour. Net power is:
  `((Base + Beer Room Boost + 15 for 15) × Shot O'Clock) − Polar Bear +
  Whose House + Happy Hour`. **Tier** (Ω Apex / Σ Prime / Δ Flux / λ
  Drift / ∅ Null) is assigned automatically from net-power rank, not set
  by hand.
- **"Apply a boost"** adds (or, with a negative amount, subtracts) a
  chosen amount to one category for one Pageboy or everyone at once —
  preset buttons fill in a sensible amount for each category, or an admin
  can type a custom one. **"Reset boosts"** zeroes every category except
  Base and Shot O'Clock's multiplier (back to 1.0×) for one person or
  everyone — the manual equivalent of an event like Happy Hour ending.

## One-time backend setup

`app.js`'s `STORE_URL` constant must point at a deployed Apps Script Web
App before the site will load (reloading with it empty shows an
instruction screen instead of the board). This only needs doing once,
ever, by one person with a Google account — nobody else needs to touch
it again after that:

1. Go to [sheets.google.com](https://sheets.google.com) and create a new
   blank spreadsheet (name doesn't matter — e.g. "Page House Points
   Data").
2. **Extensions → Apps Script.** This opens an editor bound to that
   sheet.
3. Delete the placeholder `myFunction() {...}` code and paste in the
   entire contents of this repo's `apps-script/Code.gs`.
4. Save (the disk icon, or Ctrl/Cmd+S).
5. **Deploy → New deployment.** Click the gear icon next to "Select
   type" and choose **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click **Deploy**. It'll ask you to authorize the script — click
   **Authorize access**, pick your Google account, then (since this is
   your own unpublished script) click **Advanced** → **Go to \[project
   name\] (unsafe)** → **Allow**. This warning is expected for any script
   you haven't submitted for Google's verification; it's only ever
   talking to your own spreadsheet.
7. Copy the **Web app URL** it shows you (looks like
   `https://script.google.com/macros/s/AKfycb.../exec`).
8. Paste that as the value of `STORE_URL` near the top of `app.js`,
   commit, and push. The board goes live on the next Pages deploy.

If the script or sheet ever needs editing later, the same Apps Script
editor is reachable from **Extensions → Apps Script** on that sheet —
redeploy (**Deploy → Manage deployments → edit → New version**) for code
changes to actually take effect, since Apps Script Web Apps serve
whichever version was last deployed, not always the latest saved code.

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
