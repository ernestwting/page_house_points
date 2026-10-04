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
- **Admin access is still a single shared code** (`whosehouse`), kept
  deliberately simple for admins to use — but it no longer lives in
  `app.js` at all. The code only ever exists as something an admin types
  into the login form; `app.js` sends whatever was typed to `Code.gs`,
  which is the *only* place that knows anything about it (as a salted
  SHA-256 hash, `ADMIN_CODE_HASH` — not the plain code even there).
  `Code.gs` runs entirely on Google's servers and is never downloaded by
  a browser, so View Source, the Network tab, and fetching `app.js`
  directly all show nothing related to the code — there's nothing left
  in the page to inspect. The only way to still learn it is to actually
  watch someone type and submit the real code (over their shoulder, or
  with access to their own device/session) — true of any password-based
  system, not a gap specific to this one. Submitting the login form does
  a lightweight server round-trip (`verifyOnly: true`, no write) so a
  wrong code is reported back immediately instead of failing silently on
  the next real action.
  - `Code.gs` locks out *all* further code attempts for 10 minutes after
    8 wrong guesses in a row (`AUTH_FAIL_MAX`/`AUTH_LOCKOUT_SECONDS`),
    making blind brute-forcing impractical. This is global, not
    per-person (Apps Script Web Apps don't cheaply expose caller
    identity/IP to key a per-person limit on) — a burst of wrong guesses
    from anyone locks out real admins too, for the same 10 minutes. It's
    sized loosely enough that mistyping your own memorized code a couple
    of times won't trip it.
  - **Even a *correct* code can't do what happened before.** The actual
    incident wasn't just "someone got the code" — it was a stored-XSS
    payload planted *through* valid access (see below) that mass-added
    duplicate people and an absurd stat value in one shot. `Code.gs` now
    validates every write against the *previously stored state*, not
    just in isolation: at most **one new person per write** (every real
    "Add person" click only ever adds one — more than that in a single
    write is rejected outright, regardless of how valid the code was),
    at most 3 people sharing a name, and (the real guard against a
    one-shot absurd value) a cap on how much any single field may swing
    in one write, regardless of where it already stood. None of this
    depends on the code staying secret — it holds even if a correct code
    is compromised, mistyped into the wrong context, or driven by a
    script instead of a human.
    - **Shot O'Clock** (the one field that multiplies the whole formula,
      so a huge value there wrecks every score at once) additionally
      gets a tight absolute range, 0–10 — nothing ever needs it anywhere
      near that high in one click.
    - The other five signed "swing" fields (Beer Room Boost, 15 for 15,
      Polar Bear, Whose House, Happy Hour) deliberately do **not** get a
      tight absolute range, only a generous overflow guard. Whose House
      in particular is incremented by the chaos roll every 5 minutes
      forever, by design, as an unbounded random walk — a tight absolute
      bound there doesn't stop an attack, it just means the board
      permanently locks up the first time ordinary chaos-roll drift
      crosses it. (This happened in practice during testing: chaos rolls
      alone pushed Whose House past an earlier ±1000 bound within hours,
      which then rejected *every* write on the site, including ones that
      never touched Whose House at all, since every write resubmits the
      full roster and that check ran against all of it. Fixed by moving
      the real protection onto the per-write delta cap instead, which
      holds regardless of how large the accumulated value already is.)
  - `Code.gs` also rejects obviously-spammed shapes (too many total
    people, oversized activity-log entries) as an independent layer, and
    throttles writes globally (20 per rolling 60s) so a stuck client or
    buggy script can't hammer the sheet even with a valid code.
  - **Reading the board stays fully open to everyone, no code needed**
    — only writes are gated. That's deliberate: it's meant to be a
    leaderboard everyone in the house can just look at.
  - **To change the code**: pick a new one, compute
    `SHA-256(ADMIN_CODE_SALT + "<new code>")` (e.g.
    `python3 -c "import hashlib; print(hashlib.sha256(('SALT'+'code').encode()).hexdigest())"`
    with the real salt and code substituted in), and paste the resulting
    hex string in as `Code.gs`'s `ADMIN_CODE_HASH`. Nothing in `app.js`
    needs to change, since it never contained the code.
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
  exploited the same way. A closer audit afterward found the first fix
  was itself incomplete: `escapeHtml()` only encodes `&`/`<`/`>`, which
  is sufficient for HTML *text content* but not for an HTML *attribute
  value* (`value="..."`), since a bare `"` is harmless in text content
  but breaks out of an attribute without needing `<`/`>` at all. The one
  call site that inserts a value into an attribute (`id` into
  `value="..."`) now uses a separate `escapeAttr()` that also encodes
  both quote characters. `Code.gs`'s `sanitizeIds_()` already forced
  `id` into a safe alphanumeric shape regardless, so this specific gap
  was not independently exploitable — but it's the kind of near-miss
  that's worth fixing on sight rather than leaving for a future call
  site that doesn't have that same backstop.
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
