/**
 * Page House Points — tiny JSON backend + chaos trigger.
 *
 * Deployed as a Web App (Execute as: Me, Who has access: Anyone), this
 * turns one cell of the bound spreadsheet into the whole site's shared
 * data store: GET returns it (unauthenticated — the whole point of a
 * leaderboard is being visible to everyone), POST overwrites it *after*
 * checking an admin code and running every change through bounds/shape
 * checks (see below). See README.md in the repo root for deploy steps.
 *
 * SECURITY MODEL — two separate problems, two separate fixes:
 *
 * 1) Keeping the code out of anything a browser downloads. The code is
 *    no longer anywhere in app.js — ADMIN_CODE_HASH below is the *only*
 *    copy of anything related to it, and it lives here, in Code.gs,
 *    which runs entirely on Google's servers. The browser never
 *    downloads this file's source — View Source, the Network tab, and
 *    fetching app.js directly all show nothing related to the code,
 *    unless someone actually types the real code into the form and that
 *    specific request is being watched (same as any password, anywhere
 *    — not specific to this site). ADMIN_CODE_HASH is a salted SHA-256
 *    hash, not the plain code, so even reading this file's source
 *    (e.g. a future collaborator with edit access to the Apps Script
 *    project) doesn't hand over the actual code.
 *
 * 2) Making sure a *valid* code can't do what happened before: someone
 *    with real admin access planted a stored-XSS payload through the
 *    "add person" flow that rewrote photos client-side and hijacked the
 *    add-person form into submitting the same spammed name repeatedly
 *    (13 copies of one fake person, with an absurd stat value). A
 *    correct admin code should never need to be trusted completely —
 *    validateState_() below checks every write *against the previously
 *    stored state*, not just in isolation: at most one new person per
 *    write (every real "Add person" click only ever adds one), a cap on
 *    how many people may share a name, tight per-field value ranges,
 *    and a cap on how much any one field may change in a single write.
 *    None of this depends on the admin code being kept secret — it
 *    holds even if a valid code is compromised, mistyped into the wrong
 *    place, or used by a script instead of a human.
 *
 * Deliberately avoids any CORS preflight: GET is always a CORS-simple
 * request, and the site's own fetch() POST uses a text/plain body (also
 * CORS-simple) specifically because Apps Script Web Apps don't support a
 * real doOptions() handler — a JSON content-type on POST would trigger a
 * preflight this backend can never answer correctly.
 *
 * Also runs chaosRoll() on a 5-minute time-driven trigger (installed by
 * running setupChaosTrigger() once — see README.md) to add a random
 * swing to every tracked person's Whose House category, independent of
 * whether anyone has the site open in a browser.
 */

// Salted hash of the admin code — never the plain code itself. To
// change the code: pick a new one, compute
//   SHA-256(ADMIN_CODE_SALT + "<new code>")
// (e.g. via `python3 -c "import hashlib; print(hashlib.sha256(('SALT'+'code').encode()).hexdigest())"`
// with the real salt/code substituted in), and paste the resulting hex
// string in as ADMIN_CODE_HASH. The salt isn't secret either — it just
// stops a generic precomputed hash lookup for a bare dictionary word.
var ADMIN_CODE_SALT = "pHouse_2026_s8K2qT";
var ADMIN_CODE_HASH = "835a3342f0025ad4a6970af7733112817761818551d2c94e675c2c9167ed75d0"; // "whosehouse"

var SHEET_NAME = "data";
var CELL = "A1";
var DEFAULT_STATE = JSON.stringify({
  people: [],
  activityLog: [],
  schemaVersion: 2,
});

// ---------- bounds (apply even to a correctly-authenticated write) ----------

var MAX_PEOPLE = 200;
var MAX_NAME_LENGTH = 80;
var MAX_ACTIVITY_ENTRIES = 100;
var MAX_ACTIVITY_TEXT_LENGTH = 300;

// Every real "Add person" click in app.js adds exactly one person per
// write. Capping new people per write at 1 is what actually stops a
// repeat of "13 copies of one name added at once" — MAX_PEOPLE alone
// (an overall ceiling) does not, since 13 is well under 200.
var MAX_NEW_PEOPLE_PER_WRITE = 1;

// A handful of people coincidentally sharing a name is plausible; many
// more than that, all at once, is the exact shape the spam attack took.
var MAX_NAME_DUPLICATES = 3;

// Absolute ranges. points/shotOClock get a tight, realistic range —
// shotOClock especially, since it multiplies the whole formula, so even
// a "legitimately" huge value there would wreck every score at once, and
// nothing ever needs it anywhere near this high in one click.
//
// The five signed "swing" categories deliberately do NOT get a tight
// absolute range: whoseHouse is incremented by chaosRoll() every 5
// minutes forever, by design, as an unbounded random walk (see
// chaosRoll()'s own comment — "nothing here tries to balance out over
// time"), and the others can likewise accumulate indefinitely over a
// real semester of repeated legitimate boosts. A tight absolute bound on
// any of these doesn't block an attack — it just means the board
// permanently locks up the first time organic accumulation crosses it
// (this happened in practice: chaos rolls alone pushed whoseHouse past
// a ±1000 bound within hours, which then rejected every write on the
// site — including ones that never touched whoseHouse at all, since
// every write resubmits the full roster and this check ran against all
// of it). These keep only a generous overflow guard; the real one-shot
// abuse protection for these fields is MAX_FIELD_DELTA_PER_WRITE below,
// which caps how much a single write can move a field regardless of
// where it already stood — that holds up whether the previous value
// was 5 or -2295.
var FIELD_BOUNDS = {
  points: { min: 0, max: 1000000 },
  shotOClock: { min: 0, max: 10 },
  beerRoomBoost: { min: -1000000, max: 1000000 },
  fifteenForFifteen: { min: -1000000, max: 1000000 },
  polarBear: { min: -1000000, max: 1000000 },
  whoseHouse: { min: -1000000, max: 1000000 },
  happyHour: { min: -1000000, max: 1000000 },
};

// No single write may swing any one field by more than this, regardless
// of its absolute bounds — blocks a one-shot jump to a huge value even
// if that value would otherwise be in range on its own; legitimate use
// (clicking a preset, typing a custom boost) never needs anywhere close
// to this in one submission.
var MAX_FIELD_DELTA_PER_WRITE = 200;

// Global write throttle (not per-user — Apps Script Web Apps don't
// expose caller IP/identity-keyed request info cheaply) so a stuck
// client or buggy script can't hammer the sheet.
var RATE_LIMIT_MAX_WRITES = 20;
var RATE_LIMIT_WINDOW_SECONDS = 60;

// Failed-code lockout: makes blind brute-forcing of the admin code
// impractical. This is global, not per-caller (same Apps Script
// limitation as above) — a burst of wrong guesses from anyone locks out
// every caller for the cooldown, including real admins. A real admin
// mistyping their own memorized code a couple of times won't trip this;
// it's sized for that, not for zero-tolerance.
var AUTH_FAIL_MAX = 8;
var AUTH_LOCKOUT_SECONDS = 600;

function getDataSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  return sheet;
}

function jsonOutput_(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function readState_() {
  var sheet = getDataSheet_();
  var value = sheet.getRange(CELL).getValue();
  var text = value ? String(value) : DEFAULT_STATE;
  try {
    return JSON.parse(text);
  } catch (err) {
    return JSON.parse(DEFAULT_STATE);
  }
}

function writeState_(state) {
  getDataSheet_().getRange(CELL).setValue(JSON.stringify(state));
}

function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

function verifyAdminCode_(code) {
  if (typeof code !== "string" || !code) return false;
  return sha256Hex_(ADMIN_CODE_SALT + code) === ADMIN_CODE_HASH;
}

function checkAuthLockout_() {
  return CacheService.getScriptCache().get("authLockout") !== "1";
}
function recordAuthFailure_() {
  var cache = CacheService.getScriptCache();
  var count = Number(cache.get("authFailCount") || 0) + 1;
  cache.put("authFailCount", String(count), AUTH_LOCKOUT_SECONDS);
  if (count >= AUTH_FAIL_MAX) {
    cache.put("authLockout", "1", AUTH_LOCKOUT_SECONDS);
  }
}
function clearAuthFailures_() {
  var cache = CacheService.getScriptCache();
  cache.remove("authFailCount");
  cache.remove("authLockout");
}

function checkRateLimit_() {
  var cache = CacheService.getScriptCache();
  var key = "writeCount";
  var count = Number(cache.get(key) || 0);
  if (count >= RATE_LIMIT_MAX_WRITES) return false;
  cache.put(key, String(count + 1), RATE_LIMIT_WINDOW_SECONDS);
  return true;
}

// A name/role is free text, but must never contain anything that could
// be interpreted as markup — this is checked here independently of
// whatever the frontend does with it, on the theory that a storage-layer
// guard should never depend on every future render call site remembering
// to escape correctly. (That exact assumption failing — one call site in
// app.js inserted a stored field into an HTML attribute unescaped — is
// what let a previous write plant a script that ran in every visitor's
// browser. Fixed there too, but this guard means a similar slip anywhere
// else can no longer be loaded as a payload in the first place.)
var UNSAFE_TEXT_PATTERN = /[<>]/;
var ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
var NUMERIC_FIELDS = ["points", "shotOClock", "beerRoomBoost", "fifteenForFifteen", "polarBear", "whoseHouse", "happyHour"];

/**
 * Rejects a state whose shape, magnitudes, or text content look
 * machine-spammed or injection-shaped rather than admin-entered —
 * returns an error string, or null if the state looks reasonable.
 * `oldState` (the previously stored state, read before this write) is
 * used to catch things that only look wrong *relative to before*: more
 * new people than any real single action could add, or a field jumping
 * further in one write than any real single action would.
 */
function validateState_(state, oldState) {
  if (!state || typeof state !== "object") return "State must be an object";
  if (!Array.isArray(state.people)) return "people must be an array";
  if (state.people.length > MAX_PEOPLE) return "Too many people (max " + MAX_PEOPLE + ")";

  var oldById = {};
  (oldState && oldState.people || []).forEach(function (op) {
    if (op && op.id != null) oldById[op.id] = op;
  });
  var newPeopleCount = 0;
  var nameCounts = {};

  for (var i = 0; i < state.people.length; i++) {
    var p = state.people[i];
    if (!p || typeof p !== "object") return "Each person must be an object";
    if (typeof p.name !== "string" || !p.name.trim() || p.name.length > MAX_NAME_LENGTH) {
      return "Each person needs a reasonable name";
    }
    if (UNSAFE_TEXT_PATTERN.test(p.name)) return "Name can't contain < or >";
    if (p.role != null) {
      if (typeof p.role !== "string" || p.role.length > MAX_NAME_LENGTH) return "Role is too long";
      if (UNSAFE_TEXT_PATTERN.test(p.role)) return "Role can't contain < or >";
    }

    var nameKey = p.name.trim().toLowerCase();
    nameCounts[nameKey] = (nameCounts[nameKey] || 0) + 1;
    if (nameCounts[nameKey] > MAX_NAME_DUPLICATES) {
      return "Too many people named \"" + p.name + "\" — looks spammed";
    }

    var old = p.id != null ? oldById[p.id] : null;
    if (!old) newPeopleCount++;

    for (var f = 0; f < NUMERIC_FIELDS.length; f++) {
      var field = NUMERIC_FIELDS[f];
      var v = p[field];
      if (v == null) continue;
      if (typeof v !== "number" || !isFinite(v)) return "Field " + field + " out of range for " + p.name;
      var bounds = FIELD_BOUNDS[field];
      if (v < bounds.min || v > bounds.max) {
        return "Field " + field + " out of range for " + p.name + " (must be " + bounds.min + " to " + bounds.max + ")";
      }
      if (old && old[field] != null && typeof old[field] === "number") {
        var delta = Math.abs(v - old[field]);
        if (delta > MAX_FIELD_DELTA_PER_WRITE) {
          return "Field " + field + " changed by too much in one write for " + p.name + " (max swing " + MAX_FIELD_DELTA_PER_WRITE + ")";
        }
      }
    }
  }

  if (newPeopleCount > MAX_NEW_PEOPLE_PER_WRITE) {
    return "Too many new people added in one write (max " + MAX_NEW_PEOPLE_PER_WRITE + ")";
  }

  if (state.activityLog != null) {
    if (!Array.isArray(state.activityLog)) return "activityLog must be an array";
    if (state.activityLog.length > MAX_ACTIVITY_ENTRIES) return "Too many activity entries (max " + MAX_ACTIVITY_ENTRIES + ")";
    for (var j = 0; j < state.activityLog.length; j++) {
      var entry = state.activityLog[j];
      if (!entry || typeof entry !== "object") return "Each activity entry must be an object";
      if (typeof entry.text !== "string" || entry.text.length > MAX_ACTIVITY_TEXT_LENGTH) {
        return "Activity entry text too long (max " + MAX_ACTIVITY_TEXT_LENGTH + " chars)";
      }
    }
  }

  return null;
}

/**
 * Forces every person's id into a known-safe shape (plain
 * alphanumeric/dash/underscore), replacing anything else with a fresh
 * one — belt-and-suspenders alongside the UNSAFE_TEXT_PATTERN check
 * above, specifically for the field a previous attack targeted. ids are
 * internal identifiers an admin never has a real reason to set to
 * arbitrary content, so this has no legitimate-use downside.
 */
function sanitizeIds_(people) {
  people.forEach(function (p) {
    if (typeof p.id !== "string" || !ID_PATTERN.test(p.id)) {
      p.id = Utilities.getUuid();
    }
  });
}

function doGet(e) {
  var sheet = getDataSheet_();
  var value = sheet.getRange(CELL).getValue();
  return jsonOutput_(value ? String(value) : DEFAULT_STATE);
}

function doPost(e) {
  var body = e && e.postData ? e.postData.contents : null;
  if (!body) {
    return jsonOutput_(JSON.stringify({ error: "No body received" }));
  }

  var envelope;
  try {
    envelope = JSON.parse(body);
  } catch (err) {
    return jsonOutput_(JSON.stringify({ error: "Invalid JSON: " + err.message }));
  }

  if (!checkAuthLockout_()) {
    return jsonOutput_(JSON.stringify({ error: "Too many failed attempts — locked for a few minutes" }));
  }

  if (!envelope || !verifyAdminCode_(envelope.auth)) {
    recordAuthFailure_();
    return jsonOutput_(JSON.stringify({ error: "Unauthorized" }));
  }
  clearAuthFailures_();

  // A verify-only request (used by the admin login form for instant
  // "that's not the code" feedback) never touches the sheet and isn't
  // subject to the write throttle — only to the auth lockout above,
  // which already bounds how many guesses are possible at all.
  if (envelope.verifyOnly) {
    return jsonOutput_(JSON.stringify({ status: "ok" }));
  }

  if (!checkRateLimit_()) {
    return jsonOutput_(JSON.stringify({ error: "Too many writes in a short window — try again shortly" }));
  }

  var oldState = readState_();
  var state = envelope.state;
  var validationError = validateState_(state, oldState);
  if (validationError) {
    return jsonOutput_(JSON.stringify({ error: validationError }));
  }
  sanitizeIds_(state.people);

  writeState_(state);
  return jsonOutput_(JSON.stringify({ status: "ok" }));
}

/**
 * Fires every 5 minutes once setupChaosTrigger() has been run once (see
 * README.md). Adds a fresh random integer in [-100, 100] to each tracked
 * person's Whose House value — Whose House is this board's "stochastic
 * correction" category by design, so this is purely more of what it
 * already represents, not a new mechanic bolted on. Pure chaos: every
 * roll is independent, nothing here tries to balance out over time.
 * (Not reachable over HTTP — runs only from Apps Script's own
 * time-driven trigger — so it isn't subject to the write-path checks
 * above; it doesn't need to be, since nothing external controls it.)
 */
function chaosRoll() {
  var state = readState_();
  var people = state.people || [];
  if (!people.length) return;

  var summary = [];
  people.forEach(function (p) {
    var delta = Math.floor(Math.random() * 201) - 100; // integer in [-100, 100]
    p.whoseHouse = Math.round(((p.whoseHouse || 0) + delta) * 100) / 100;
    summary.push(p.name + " " + (delta >= 0 ? "+" : "") + delta);
  });

  state.activityLog = state.activityLog || [];
  state.activityLog.unshift({
    id: "chaos-" + Date.now(),
    timestamp: new Date().toISOString(),
    text: "🎲 Chaos roll — " + summary.join(", "),
  });
  state.activityLog = state.activityLog.slice(0, 60);

  writeState_(state);
}

/**
 * Run this once, manually, from this editor (select it in the function
 * dropdown at the top, then click Run) to start the 5-minute chaos
 * trigger. Safe to re-run — it clears any previous chaosRoll triggers
 * first, so it never ends up double-firing.
 */
function setupChaosTrigger() {
  removeChaosTrigger();
  ScriptApp.newTrigger("chaosRoll").timeBased().everyMinutes(5).create();
}

/** Run this once, manually, to stop the chaos roll entirely. */
function removeChaosTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "chaosRoll") ScriptApp.deleteTrigger(t);
  });
}
