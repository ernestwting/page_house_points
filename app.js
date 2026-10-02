(function () {
  "use strict";

  // Public, no-login JSON store (jsonblob.com — see README). Reading/
  // writing this URL is all the "backend" this static site has, by design.
  // BLOB_ID is empty until the one-time setup step (see setupScreen below)
  // creates the shared blob and this constant gets hardcoded with its id.
  var STORE_BASE = "https://jsonblob.com/api/jsonBlob/";
  var BLOB_ID = "";
  var STORE_URL = BLOB_ID ? STORE_BASE + BLOB_ID : null;
  var ADMIN_CODE = "whosehouse";
  var POLL_MS = 20000;

  var state = { people: [], modifiers: [], activityLog: [], schemaVersion: 1 };
  var previousRanks = {}; // personId -> rank, client-side only, for the ▲▼ indicator
  var isAdmin = sessionStorage.getItem("phpAdmin") === "1";

  // ---------- small utilities ----------

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function fmtPoints(n) {
    var r = round2(n || 0);
    return Number.isInteger(r) ? String(r) : r.toFixed(2);
  }

  function fmtClock(d) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
  }

  function byId(id) { return document.getElementById(id); }

  // ---------- state helpers ----------

  function activeModifiers(now) {
    now = now || Date.now();
    return (state.modifiers || []).filter(function (m) {
      return !m.expiresAt || new Date(m.expiresAt).getTime() > now;
    });
  }

  function multiplierFor(personId, now) {
    var mods = activeModifiers(now);
    var mult = 1;
    mods.forEach(function (m) {
      if (m.scope === "all" || m.scope === personId) mult *= Number(m.multiplier) || 1;
    });
    return mult;
  }

  function personById(id) {
    return (state.people || []).find(function (p) { return p.id === id; });
  }

  function pruneExpiredModifiers() {
    var now = Date.now();
    state.modifiers = activeModifiers(now);
  }

  function logActivity(entry) {
    entry.id = uid();
    entry.timestamp = new Date().toISOString();
    state.activityLog = state.activityLog || [];
    state.activityLog.unshift(entry);
    // Keep the store from growing forever — this is a fun ticker, not an audit log.
    state.activityLog = state.activityLog.slice(0, 60);
  }

  // ---------- network ----------

  function fetchState() {
    return fetch(STORE_URL + "?_=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("GET failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        state = Object.assign({ people: [], modifiers: [], activityLog: [], schemaVersion: 1 }, data);
        state.people = state.people || [];
        state.modifiers = state.modifiers || [];
        state.activityLog = state.activityLog || [];
      });
  }

  function saveState() {
    pruneExpiredModifiers();
    return fetch(STORE_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    }).then(function (res) {
      if (!res.ok) throw new Error("PUT failed: " + res.status);
    });
  }

  function withSavingUi(promise, formEl) {
    var btn = formEl ? formEl.querySelector("button[type=submit]") : null;
    var prevText = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    return promise
      .then(function () { setSyncStatus("Synced at " + fmtClock(new Date())); })
      .catch(function (err) {
        console.error(err);
        setSyncStatus("Couldn't reach the data store — try again.", true);
        alert("That didn't save — the shared data store didn't respond. Nothing changed on the board yet; try again.");
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = prevText; }
      });
  }

  // ---------- rendering ----------

  function setSyncStatus(text, isError) {
    var el = byId("sync-status");
    el.textContent = text;
    el.style.color = isError ? "var(--accent-red)" : "";
  }

  function renderLeaderboard() {
    var body = byId("leaderboard-body");
    var table = byId("leaderboard");
    var empty = byId("leaderboard-empty");

    var people = (state.people || []).slice().sort(function (a, b) { return b.points - a.points; });

    if (!people.length) {
      table.hidden = true;
      empty.hidden = false;
      body.innerHTML = "";
      return;
    }
    table.hidden = false;
    empty.hidden = true;

    var newRanks = {};
    body.innerHTML = people.map(function (p, i) {
      var rank = i + 1;
      newRanks[p.id] = rank;
      var prevRank = previousRanks[p.id];
      var deltaHtml = "";
      if (prevRank != null && prevRank !== rank) {
        var moved = prevRank - rank; // positive = moved up
        deltaHtml = '<span class="point-delta ' + (moved > 0 ? "up" : "down") + '">' +
          (moved > 0 ? "▲" : "▼") + Math.abs(moved) + "</span>";
      }
      var rankClass = rank <= 3 ? "rank-" + rank : "";
      return (
        '<tr class="' + rankClass + '">' +
        '<td class="col-rank">' + rank + "</td>" +
        '<td class="person-name">' + escapeHtml(p.name) + deltaHtml + "</td>" +
        '<td class="col-points">' + fmtPoints(p.points) + "</td>" +
        "</tr>"
      );
    }).join("");
    previousRanks = newRanks;
  }

  function renderBoosts() {
    var list = byId("boosts-list");
    var empty = byId("boosts-empty");
    var ticker = byId("boost-ticker");
    var now = Date.now();
    var mods = activeModifiers(now);

    if (!mods.length) {
      list.innerHTML = "";
      empty.hidden = false;
      ticker.hidden = true;
      return;
    }
    empty.hidden = true;

    list.innerHTML = mods.map(function (m) {
      var scopeLabel = m.scope === "all" ? "All Pageboys" : (function () {
        var p = personById(m.scope);
        return p ? p.name : "(removed person)";
      })();
      var countdown = m.expiresAt
        ? formatCountdown(new Date(m.expiresAt).getTime() - now)
        : "No expiry";
      var endBtn = isAdmin
        ? '<button class="btn btn-small btn-ghost end-boost-btn" data-id="' + m.id + '" type="button">End</button>'
        : "";
      return (
        '<li class="boost-item" data-expires="' + (m.expiresAt || "") + '">' +
        "<span>" +
        '<span class="boost-name">' + escapeHtml(m.name) + "</span><br>" +
        '<span class="boost-meta">×' + m.multiplier + " · " + escapeHtml(scopeLabel) + "</span>" +
        "</span>" +
        '<span class="boost-countdown" data-countdown>' + countdown + "</span>" +
        endBtn +
        "</li>"
      );
    }).join("");

    Array.prototype.forEach.call(list.querySelectorAll(".end-boost-btn"), function (btn) {
      btn.addEventListener("click", function () { endBoost(btn.getAttribute("data-id")); });
    });

    // Ticker: active boosts scrolling across the header, duplicated once
    // so the -50% translateX CSS animation loops without a visible seam.
    var tickerText = mods.map(function (m) {
      return "🍺 " + m.name + " ×" + m.multiplier + " active";
    }).join("  •  ");
    byId("ticker-track").innerHTML = escapeHtml(tickerText) + "&nbsp;&nbsp;•&nbsp;&nbsp;" + escapeHtml(tickerText);
    ticker.hidden = false;
  }

  function formatCountdown(ms) {
    if (ms <= 0) return "Ending…";
    var totalSec = Math.floor(ms / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
  }

  function tickCountdowns() {
    // Cheap per-second visual tick between full re-renders/polls.
    var now = Date.now();
    var any = false;
    Array.prototype.forEach.call(document.querySelectorAll("#boosts-list li[data-expires]"), function (li) {
      var exp = li.getAttribute("data-expires");
      if (!exp) return;
      any = true;
      var remaining = new Date(exp).getTime() - now;
      li.querySelector("[data-countdown]").textContent = formatCountdown(remaining);
    });
    if (any && activeModifiers(now).length !== document.querySelectorAll("#boosts-list li").length) {
      renderBoosts(); // something expired since the last full render
    }
  }

  function renderActivity() {
    var list = byId("activity-list");
    var empty = byId("activity-empty");
    var entries = (state.activityLog || []).slice(0, 15);
    if (!entries.length) {
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = entries.map(function (e) {
      return (
        '<li class="activity-item">' + escapeHtml(e.text) +
        '<span class="activity-time">' + new Date(e.timestamp).toLocaleString() + "</span>" +
        "</li>"
      );
    }).join("");
  }

  function renderAdminSelects() {
    var people = (state.people || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    var personOptions = people.map(function (p) {
      return '<option value="' + p.id + '">' + escapeHtml(p.name) + "</option>";
    }).join("");

    byId("add-points-person").innerHTML = personOptions || '<option value="">No people yet</option>';
    byId("remove-points-person").innerHTML = personOptions || '<option value="">No people yet</option>';
    byId("remove-person-select").innerHTML = personOptions || '<option value="">No people yet</option>';
    byId("boost-scope").innerHTML = '<option value="all">All Pageboys</option>' + personOptions;

    updateAddPointsPreview();
  }

  function updateAddPointsPreview() {
    var personId = byId("add-points-person").value;
    var amount = parseFloat(byId("add-points-amount").value);
    var preview = byId("add-points-preview");
    if (!personId || isNaN(amount)) { preview.textContent = ""; return; }
    var mult = multiplierFor(personId, Date.now());
    var final = round2(amount * mult);
    preview.textContent = mult !== 1
      ? amount + " pts × " + mult + " active boost = " + final + " pts"
      : final + " pts (no active boost)";
  }

  function renderAll() {
    renderLeaderboard();
    renderBoosts();
    renderActivity();
    renderAdminSelects();
  }

  // ---------- admin actions ----------

  function requireAdmin() {
    if (!isAdmin) { alert("Admin is locked."); return false; }
    return true;
  }

  function addPoints(personId, amount, reason) {
    var person = personById(personId);
    if (!person) return;
    var mult = multiplierFor(personId, Date.now());
    var finalAmount = round2(amount * mult);
    person.points = round2((person.points || 0) + finalAmount);
    var text = person.name + " gained " + finalAmount + " pts" +
      (mult !== 1 ? " (" + amount + " × " + mult + ")" : "") +
      (reason ? " — " + reason : "");
    logActivity({ type: "add", text: text });
  }

  function removePoints(personId, amount, reason) {
    var person = personById(personId);
    if (!person) return;
    person.points = round2((person.points || 0) - amount);
    var text = person.name + " lost " + amount + " pts" + (reason ? " — " + reason : "");
    logActivity({ type: "remove", text: text });
  }

  function addPerson(name) {
    var id = uid();
    state.people.push({ id: id, name: name, points: 0 });
    logActivity({ type: "addPerson", text: name + " joined the board" });
  }

  function removePerson(personId) {
    var person = personById(personId);
    if (!person) return;
    state.people = state.people.filter(function (p) { return p.id !== personId; });
    state.modifiers = (state.modifiers || []).filter(function (m) { return m.scope !== personId; });
    logActivity({ type: "removePerson", text: person.name + " was removed from the board" });
  }

  function addBoost(name, multiplier, scope, durationMin) {
    var now = new Date();
    var expiresAt = durationMin > 0
      ? new Date(now.getTime() + durationMin * 60000).toISOString()
      : null;
    state.modifiers.push({
      id: uid(), name: name, multiplier: multiplier, scope: scope,
      createdAt: now.toISOString(), expiresAt: expiresAt,
    });
    var scopeLabel = scope === "all" ? "everyone" : (personById(scope) || {}).name || "someone";
    logActivity({
      type: "boostStart",
      text: name + " started — ×" + multiplier + " for " + scopeLabel +
        (expiresAt ? " for " + durationMin + " min" : " until ended"),
    });
  }

  function endBoost(id) {
    if (!requireAdmin()) return;
    var mod = (state.modifiers || []).find(function (m) { return m.id === id; });
    if (!mod) return;
    state.modifiers = state.modifiers.filter(function (m) { return m.id !== id; });
    logActivity({ type: "boostEnd", text: mod.name + " ended early" });
    renderAll();
    withSavingUi(saveState());
  }

  // ---------- admin UI wiring ----------

  function unlockAdmin() {
    isAdmin = true;
    sessionStorage.setItem("phpAdmin", "1");
    byId("admin-locked").hidden = true;
    byId("admin-unlocked").hidden = false;
    renderAll(); // boost "End" buttons only show once unlocked
  }

  function lockAdmin() {
    isAdmin = false;
    sessionStorage.removeItem("phpAdmin");
    byId("admin-locked").hidden = false;
    byId("admin-unlocked").hidden = true;
    renderAll();
  }

  function wireAdminForms() {
    byId("admin-login-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var code = byId("admin-code").value.trim().toLowerCase();
      if (code === ADMIN_CODE) {
        byId("admin-login-error").hidden = true;
        byId("admin-code").value = "";
        unlockAdmin();
      } else {
        byId("admin-login-error").hidden = false;
      }
    });

    byId("admin-lock-btn").addEventListener("click", lockAdmin);

    byId("add-points-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!requireAdmin()) return;
      var personId = byId("add-points-person").value;
      var amount = parseFloat(byId("add-points-amount").value);
      var reason = byId("add-points-reason").value.trim();
      if (!personId || isNaN(amount) || amount < 0) return;
      addPoints(personId, amount, reason);
      ev.target.reset();
      renderAll();
      withSavingUi(saveState(), ev.target);
    });
    byId("add-points-person").addEventListener("change", updateAddPointsPreview);
    byId("add-points-amount").addEventListener("input", updateAddPointsPreview);

    byId("remove-points-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!requireAdmin()) return;
      var personId = byId("remove-points-person").value;
      var amount = parseFloat(byId("remove-points-amount").value);
      var reason = byId("remove-points-reason").value.trim();
      if (!personId || isNaN(amount) || amount < 0) return;
      removePoints(personId, amount, reason);
      ev.target.reset();
      renderAll();
      withSavingUi(saveState(), ev.target);
    });

    byId("add-boost-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!requireAdmin()) return;
      var name = byId("boost-name").value.trim();
      var multiplier = parseFloat(byId("boost-multiplier").value);
      var scope = byId("boost-scope").value;
      var duration = parseInt(byId("boost-duration").value, 10);
      if (!name || isNaN(multiplier) || multiplier <= 0) return;
      addBoost(name, multiplier, scope, duration);
      ev.target.reset();
      byId("boost-multiplier").value = "1.5";
      renderAll();
      withSavingUi(saveState(), ev.target);
    });

    byId("add-person-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!requireAdmin()) return;
      var name = byId("person-name").value.trim();
      if (!name) return;
      addPerson(name);
      ev.target.reset();
      renderAll();
      withSavingUi(saveState(), ev.target);
    });

    byId("remove-person-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!requireAdmin()) return;
      var personId = byId("remove-person-select").value;
      if (!personId) return;
      var person = personById(personId);
      if (!person || !confirm("Remove " + person.name + " from the board? This can't be undone.")) return;
      removePerson(personId);
      renderAll();
      withSavingUi(saveState(), ev.target);
    });
  }

  // ---------- theme toggle ----------

  function wireTheme() {
    var saved = localStorage.getItem("phpTheme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    byId("theme-toggle").addEventListener("click", function () {
      var current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
      var next = current === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("phpTheme", next);
    });
  }

  // ---------- boot ----------

  function refresh() {
    return fetchState()
      .then(renderAll)
      .then(function () { setSyncStatus("Synced at " + fmtClock(new Date())); })
      .catch(function (err) {
        console.error(err);
        setSyncStatus("Couldn't load the board — retrying…", true);
      });
  }

  // One-time setup: creates the shared jsonblob.com blob this whole site
  // reads/writes, then shows the id to hardcode into BLOB_ID above. Only
  // ever needs to run once, from any real browser — the scripted request
  // this was developed against got Cloudflare-bot-challenged, which a real
  // browser executing this same click does not hit.
  function wireSetupScreen() {
    byId("setup-btn").addEventListener("click", function () {
      var btn = byId("setup-btn");
      var result = byId("setup-result");
      btn.disabled = true;
      btn.textContent = "Creating…";
      fetch(STORE_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ people: [], modifiers: [], activityLog: [], schemaVersion: 1 }),
      })
        .then(function (res) {
          if (!res.ok) throw new Error("Create failed: " + res.status);
          var id = res.headers.get("X-jsonblob-id");
          if (!id) {
            var loc = res.headers.get("Location") || "";
            id = loc.split("/").filter(Boolean).pop();
          }
          if (!id) throw new Error("No blob id returned");
          result.hidden = false;
          result.innerHTML =
            "Board created. Send this line to whoever's deploying the site " +
            "— it goes near the top of <code>app.js</code>, replacing " +
            "the empty <code>BLOB_ID</code>:<code>var BLOB_ID = \"" + id + "\";</code>";
          btn.textContent = "Done";
        })
        .catch(function (err) {
          console.error(err);
          result.hidden = false;
          result.textContent = "Couldn't create the board (" + err.message + "). Try again in a moment.";
          btn.disabled = false;
          btn.textContent = "Initialize the board";
        });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    wireTheme();

    if (!STORE_URL) {
      byId("setup-screen").hidden = false;
      wireSetupScreen();
      return;
    }

    byId("main-layout").hidden = false;
    wireAdminForms();
    if (isAdmin) unlockAdmin();

    byId("refresh-btn").addEventListener("click", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refresh();
    });

    refresh();
    setInterval(refresh, POLL_MS);
    setInterval(tickCountdowns, 1000);
  });
})();
