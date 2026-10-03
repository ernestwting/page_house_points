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
  set in both `app.js`'s `ADMIN_CODE` *and* `Code.gs`'s `ADMIN_CODE` —
  **the two must match**). Entered once per browser tab
  (`sessionStorage`) on the frontend; every write also carries it to
  `Code.gs`, which rejects anything that doesn't match *before* touching
  the sheet. This closes the hole that let someone replace every real
  person with spam data in testing — the backend used to accept any POST
  from anyone who found the URL, with no check at all. It's still **not
  real security** against someone who actually reads `app.js`'s source
  (the code is necessarily plain text there, for the browser to send it)
  — don't put anything in here you wouldn't want a sufficiently motivated
  Pageboy to mess with. `Code.gs` also rejects obviously-spammed shapes
  (hundreds of people, individual field values past ±100,000) as a second
  layer, independent of the code check.
- **Every stored field gets escaped before going into HTML, and `Code.gs`
  independently rejects `<`/`>` in names/roles and forces every `id` into
  a safe alphanumeric shape** (`sanitizeIds_()`). This is a direct fix
  for a real stored-XSS attack: one HTML-building line in `app.js`
  inserted a person's `id` into the admin dropdown without escaping
  (while the `name` right next to it *was* escaped), and someone with
  write access used that gap to plant a script in the `id` field that
  ran in every visitor's browser — rewriting the floater photos'
  `src` client-side (the actual image files were never touched) and
  hijacking the "add person" form to always submit a fixed name. Fixed
  at both layers: the actual escaping bug in `app.js`, and a
  Code.gs-side guard so a similar miss at any other call site can't be
  exploited the same way.
- **Each Pageboy has seven scoring categories feeding into one computed
  total ("Net power")**: Points, Shot O'Clock (a multiplier), Beer Room
  Boost, 15 for 15, Polar Bear, Whose House, and Happy Hour. Net power is:
  `((Points + Beer Room Boost + 15 for 15) × Shot O'Clock) + Polar Bear +
  Whose House + Happy Hour`. Polar Bear/Whose House/Happy Hour are signed
  (can be positive or negative) like a scoreboard swing — Polar Bear is
  meant as a penalty, so its preset button applies a *negative* amount by
  default, rather than being a magnitude that's always force-subtracted
  (an earlier version did that, which meant a "+1 Polar Bear" button
  always made net power go *down* — confusing, since the button read
  positive but did the opposite). **Tier** (Ω Apex / Σ Prime / Δ Flux / λ
  Drift / ∅ Null) is assigned automatically from net-power rank, not set
  by hand.
- **"Apply a boost"** adds (or, with a negative amount, subtracts) a
  chosen amount to one category for one Pageboy or everyone at once —
  preset buttons fill in a sensible amount for each category, or an admin
  can type a custom one. **"Reset boosts"** zeroes every category except
  Points and Shot O'Clock's multiplier (back to 1.0×) for one person or
  everyone — the manual equivalent of an event like Happy Hour ending.
- **Frosh Role** — an optional free-text field set when a person is
  added (shown as its own column, next to Name). Purely descriptive;
  nothing in the scoring reads it.
- **Chaos roll**: every 5 minutes, a Google Apps Script time-driven
  trigger (`chaosRoll()` in `Code.gs` — see setup below) adds a fresh
  random integer in [-100, 100] to *every* tracked person's Whose House
  value, independent of whether anyone has the site open. This runs
  server-side on purpose, not via a `setInterval` in the browser — a
  client-side timer would only fire for whoever happened to have a tab
  open (and fire *once per open tab*, compounding if more than one
  person had the board up), which isn't a fair "everyone gets the same
  chaos" mechanic.

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
9. **To turn on the 5-minute chaos roll**: back in the Apps Script
   editor, pick `setupChaosTrigger` from the function dropdown at the
   top (next to the Run/Debug buttons) and click **Run**. It'll ask for
   a separate authorization the first time (triggers need their own
   consent) — same "unsafe" warning as step 6, same reason, click through
   it the same way. That's it; it keeps running on Google's servers from
   then on, with nothing else to maintain. To stop it later, run
   `removeChaosTrigger` the same way.

If the script or sheet ever needs editing later, the same Apps Script
editor is reachable from **Extensions → Apps Script** on that sheet —
redeploy (**Deploy → Manage deployments → edit → New version**) for code
changes to actually take effect, since Apps Script Web Apps serve
whichever version was last deployed, not always the latest saved code.
(The chaos trigger isn't part of that deployment, though — it's a
separate project-level trigger, so `setupChaosTrigger`/`removeChaosTrigger`
only ever need running directly from the editor, never redeployed.)

## Deploying

Push to `main`. GitHub Pages (Settings → Pages → Source: `main` branch,
`/ (root)`) serves it directly — no Actions workflow needed for a plain
static site like this.

**Custom domain**: the repo's `CNAME` file points this site at
`pagehouse.site`. That file alone isn't enough — the domain's own DNS
(managed wherever it was bought, e.g. Namecheap) needs to point at
GitHub Pages too: four `A` records on `@` to
`185.199.108.153`/`.109.153`/`.110.153`/`.111.153`, plus (optional but
recommended) a `CNAME` record on `www` to `ernestwting.github.io`. See
[GitHub's own custom-domain docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)
for the full walkthrough. Once DNS resolves, Settings → Pages shows a
green check next to the custom domain and an "Enforce HTTPS" checkbox
becomes available — turn that on once it appears (GitHub needs the DNS
to be live first to issue the certificate, so it may not show up
immediately).

**Whenever `style.css` or `app.js` change, bump the `?v=N` query string
on their `<link>`/`<script>` tags in `index.html`.** Browsers cache these
files aggressively by URL; without a version bump, a returning visitor
can keep seeing the *old* file layered under the *new* `index.html` (odd
partial-looking styling, or old behavior) until something else happens
to clear their cache. A hard refresh (Cmd/Ctrl+Shift+R) fixes it for one
visitor on one visit; the version bump is what fixes it for everyone,
permanently, the moment they reload.

## Local preview

Any static file server works, e.g.:

```
python3 -m http.server 8000
```

then open `http://localhost:8000`.
