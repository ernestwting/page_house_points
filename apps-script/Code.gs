/**
 * Page House Points — tiny JSON backend + chaos trigger.
 *
 * Deployed as a Web App (Execute as: Me, Who has access: Anyone), this
 * turns one cell of the bound spreadsheet into the whole site's shared
 * data store: GET returns it (unauthenticated — the whole point of a
 * leaderboard is being visible to everyone), POST overwrites it *after*
 * checking an admin code (see ADMIN_CODE below). See README.md in the
 * repo root for the exact deploy steps.
 *
 * SECURITY NOTE: ADMIN_CODE here must match app.js's ADMIN_CODE exactly
 * — the UI sends it with every write. This blocks a write that carries
 * no code or the wrong one (confirmed necessary: without this check,
 * literally anyone who found this URL — via the browser's own Network
 * tab, no special access needed — could POST arbitrary data with zero
 * knowledge of the admin code at all, which is exactly what happened
 * once in testing, replacing every real person with 13 copies of a fake
 * name and a billion-times multiplier). It does NOT make this
 * cryptographically secure: ADMIN_CODE is plain text in app.js too,
 * which every visitor's browser downloads, so anyone who reads that
 * file still has the same write access a real admin does. What this
 * closes is the *zero-knowledge* hole, not a determined, technical
 * person's.
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

var ADMIN_CODE = "whosehouse"; // must match app.js's ADMIN_CODE exactly
var SHEET_NAME = "data";
var CELL = "A1";
var DEFAULT_STATE = JSON.stringify({
  people: [],
  activityLog: [],
  schemaVersion: 2,
});

// Loose sanity bounds — generous enough that a real admin's biggest
// intentional boost still fits, but reject anything shaped like a script
// spamming the endpoint (absurd magnitudes, hundreds of fake people).
var MAX_PEOPLE = 200;
var MAX_FIELD_MAGNITUDE = 100000;
var MAX_NAME_LENGTH = 80;

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

/**
 * Rejects a state whose shape, magnitudes, or text content look
 * machine-spammed or injection-shaped rather than admin-entered —
 * returns an error string, or null if the state looks reasonable. Not a
 * strict schema check (new fields are allowed through unchanged); just a
 * blast-radius limiter.
 */
function validateState_(state) {
  if (!state || typeof state !== "object") return "State must be an object";
  if (!Array.isArray(state.people)) return "people must be an array";
  if (state.people.length > MAX_PEOPLE) return "Too many people (max " + MAX_PEOPLE + ")";

  var numericFields = ["points", "shotOClock", "beerRoomBoost", "fifteenForFifteen", "polarBear", "whoseHouse", "happyHour"];
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
    for (var f = 0; f < numericFields.length; f++) {
      var v = p[numericFields[f]];
      if (v != null && (typeof v !== "number" || !isFinite(v) || Math.abs(v) > MAX_FIELD_MAGNITUDE)) {
        return "Field " + numericFields[f] + " out of range for " + p.name;
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

  if (!envelope || envelope.auth !== ADMIN_CODE) {
    return jsonOutput_(JSON.stringify({ error: "Unauthorized" }));
  }

  var state = envelope.state;
  var validationError = validateState_(state);
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
