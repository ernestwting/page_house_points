/**
 * Page House Points — tiny JSON backend + chaos trigger.
 *
 * Deployed as a Web App (Execute as: Me, Who has access: Anyone), this
 * turns one cell of the bound spreadsheet into the whole site's shared
 * data store: GET returns it, POST overwrites it. See README.md in the
 * repo root for the exact deploy steps.
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

var SHEET_NAME = "data";
var CELL = "A1";
var DEFAULT_STATE = JSON.stringify({
  people: [],
  activityLog: [],
  schemaVersion: 2,
});

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
  try {
    JSON.parse(body); // validate before writing — never store malformed JSON
  } catch (err) {
    return jsonOutput_(JSON.stringify({ error: "Invalid JSON: " + err.message }));
  }
  getDataSheet_().getRange(CELL).setValue(body);
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
