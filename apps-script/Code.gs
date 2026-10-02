/**
 * Page House Points — tiny JSON backend.
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
 */

var SHEET_NAME = "data";
var CELL = "A1";
var DEFAULT_STATE = JSON.stringify({
  people: [],
  modifiers: [],
  activityLog: [],
  schemaVersion: 1,
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

function doGet(e) {
  var sheet = getDataSheet_();
  var value = sheet.getRange(CELL).getValue();
  return jsonOutput_(value ? String(value) : DEFAULT_STATE);
}

function doPost(e) {
  var sheet = getDataSheet_();
  var body = e && e.postData ? e.postData.contents : null;
  if (!body) {
    return jsonOutput_(JSON.stringify({ error: "No body received" }));
  }
  try {
    JSON.parse(body); // validate before writing — never store malformed JSON
  } catch (err) {
    return jsonOutput_(JSON.stringify({ error: "Invalid JSON: " + err.message }));
  }
  sheet.getRange(CELL).setValue(body);
  return jsonOutput_(JSON.stringify({ status: "ok" }));
}
