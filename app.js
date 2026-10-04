(function () {
  "use strict";

  // A Google Apps Script Web App (bound to a Google Sheet) is this static
  // site's entire "backend" — see apps-script/Code.gs and README.md for
  // what it does and how to deploy it.
  var STORE_URL = "https://script.google.com/macros/s/AKfycbwJwiWBKj2s3ls2HDN6cBJpEzhRaQ3oPi08v5MTSp7d_wOmrofwVOZGHkbQ9XXNaIkTXw/exec";
  var POLL_MS = 20000;

  var CATEGORY_LABELS = {
    points: "Points", shotOClock: "Shot O'Clock", beerRoomBoost: "Beer Room Boost",
    fifteenForFifteen: "15 for 15", polarBear: "Polar Bear", whoseHouse: "Whose House", happyHour: "Happy Hour",
  };
  var RESETTABLE = ["beerRoomBoost", "fifteenForFifteen", "polarBear", "whoseHouse", "happyHour"];

  var state = { people: [], activityLog: [], schemaVersion: 2 };
  var previousRank = {}; // personId -> rank, client-side only, for the ▲▼ indicator
  var openDetailId = null;
  // The admin code itself is never hardcoded anywhere in this file —
  // only whatever an admin actually types in the login form, kept here
  // (and in sessionStorage, so a reload in the same tab doesn't need
  // re-entry) for as long as this tab considers itself unlocked. The
  // real check happens server-side in Code.gs against a salted hash, on
  // every single write — this variable only gates which UI is shown; a
  // wrong or stale value here gets rejected there regardless.
  var adminCode = sessionStorage.getItem("phpAdminCode") || null;
  var isAdmin = !!adminCode;

  // ---------- small utilities ----------

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }
  function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
  function fmt(n, d) {
    d = d == null ? 2 : d;
    var r = round2(n || 0);
    return Number.isInteger(r) && d !== 3 ? String(r) : r.toFixed(d);
  }
  function signed(n, d) {
    var r = round2(n || 0);
    return (r >= 0 ? "+" : "") + fmt(r, d);
  }
  function fmtClock(d) { return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
  }
  // escapeHtml() alone is only safe inside HTML *text content* — the
  // textContent/innerHTML round-trip it uses encodes & < > but not
  // quote characters, since a bare quote is harmless in text content.
  // It is NOT safe inside an attribute value (e.g. value="..."): a
  // string like `x" onmouseover="...` would pass through escapeHtml()
  // unchanged and break out of the attribute via the unescaped quote,
  // without needing < or > at all. escapeAttr() additionally encodes
  // both quote characters for exactly that context.
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function byId(id) { return document.getElementById(id); }

  // ---------- scoring ----------

  function netPower(p) {
    // Polar Bear is a signed swing like Whose House/Happy Hour (typically
    // negative, since it's meant as a penalty) rather than a magnitude
    // that gets force-subtracted — a magnitude model meant a "+1 Polar
    // Bear" boost (which correctly added 1 to the stored value) always
    // made net power go *down*, which reads as exactly backwards from
    // the button that caused it.
    return ((p.points + p.beerRoomBoost + p.fifteenForFifteen) * p.shotOClock) + p.polarBear + p.whoseHouse + p.happyHour;
  }

  function tierFor(fraction) {
    if (fraction < 0.10) return "Ω Apex";
    if (fraction < 0.30) return "Σ Prime";
    if (fraction < 0.60) return "Δ Flux";
    if (fraction < 0.85) return "λ Drift";
    return "∅ Null";
  }

  function rankedPeople() {
    var people = (state.people || []).map(function (p) {
      return Object.assign({}, p, { net: netPower(p) });
    });
    people.sort(function (a, b) { return b.net - a.net; });
    var total = people.length;
    people.forEach(function (p, i) {
      p.rank = i + 1;
      p.tierText = tierFor(total > 0 ? i / total : 0);
      p.tierSym = p.tierText.charAt(0);
    });
    return people;
  }

  function personById(id) { return (state.people || []).find(function (p) { return p.id === id; }); }

  function logActivity(text) {
    state.activityLog = state.activityLog || [];
    state.activityLog.unshift({ id: uid(), timestamp: new Date().toISOString(), text: text });
    state.activityLog = state.activityLog.slice(0, 60); // ticker/feed, not an audit log
  }

  // ---------- network ----------

  function fetchState() {
    return fetch(STORE_URL + "?_=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("GET failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        state = Object.assign({ people: [], activityLog: [], schemaVersion: 2 }, data);
        state.people = state.people || [];
        state.activityLog = state.activityLog || [];
      });
  }

  function saveState() {
    // Content-Type is deliberately left as the fetch default (text/plain)
    // rather than application/json: that keeps this a CORS-simple request
    // (no preflight), since Apps Script Web Apps can't answer a real
    // OPTIONS preflight. Code.gs's doPost() parses the body as JSON
    // regardless of the declared content type.
    //
    // Wrapped with { auth, state } rather than posting state directly:
    // Code.gs hashes `auth` and compares it to a salted hash — the real
    // code lives only there, never in this file — and independently
    // re-validates every field of `state` against bounds and against
    // what was previously stored (see Code.gs's validateState_) before
    // writing anything. Every write handler in this file already runs
    // behind requireAdmin(), so adminCode is always set here, but
    // Code.gs is the actual authority, not this tab's local flag.
    return fetch(STORE_URL, { method: "POST", body: JSON.stringify({ auth: adminCode, state: state }) })
      .then(function (res) {
        if (!res.ok) throw new Error("POST failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data && data.error) {
          if (data.error === "Unauthorized") {
            lockAdmin();
            byId("admin-login-error").hidden = false;
            alert("That admin code is no longer valid — sign in again to keep making changes.");
          }
          // Tagged so withSavingUi can show Code.gs's actual reason
          // (e.g. a specific validation rule that rejected the write)
          // instead of a generic "didn't respond" message that reads
          // the same whether the problem was a real network failure or
          // a deliberate, specific rejection server-side.
          var err = new Error(data.error);
          err.isServerError = true;
          throw err;
        }
      });
  }

  function withSavingUi(promise, formEl) {
    var btn = formEl ? formEl.querySelector("button[type=submit]") : null;
    var prevText = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    return promise
      .then(function () { byId("sync-status").textContent = "Synced " + fmtClock(new Date()); })
      .catch(function (err) {
        console.error(err);
        byId("sync-status").textContent = "Couldn't save — try again";
        if (err && err.isServerError) {
          alert("That didn't save: " + err.message);
        } else {
          alert("That didn't save — the shared data store didn't respond. Nothing changed on the board yet; try again.");
        }
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = prevText; }
      });
  }

  // ---------- rendering ----------

  function renderLeaderboard() {
    var body = byId("leaderboard-body");
    var table = byId("leaderboard");
    var empty = byId("leaderboard-empty");
    var people = rankedPeople();

    byId("people-count").textContent = people.length
      ? people.length + " Pageboy" + (people.length === 1 ? "" : "s") + " tracked"
      : "No Pageboys tracked yet";

    if (!people.length) {
      table.hidden = true;
      empty.hidden = false;
      body.innerHTML = "";
      return people;
    }
    table.hidden = false;
    empty.hidden = true;

    var newRank = {};
    body.innerHTML = "";
    people.forEach(function (p) {
      newRank[p.id] = p.rank;
      var prev = previousRank[p.id];
      var arrow = "";
      if (prev != null && prev !== p.rank) {
        var moved = prev - p.rank;
        arrow = '<span class="arrow ' + (moved > 0 ? "pos" : "neg") + '">' + (moved > 0 ? "▲" : "▼") + Math.abs(moved) + "</span>";
      }
      var tr = document.createElement("tr");
      tr.className = "row";
      tr.tabIndex = 0;
      tr.dataset.id = p.id;
      tr.innerHTML =
        '<td class="rank">' + p.rank + "</td>" +
        '<td class="name">' + escapeHtml(p.name) + "</td>" +
        '<td class="role">' + escapeHtml(p.role || "") + "</td>" +
        '<td><span class="tier t-' + p.tierSym + '">' + p.tierText + "</span></td>" +
        "<td>" + fmt(p.points) + "</td>" +
        "<td>×" + fmt(p.shotOClock) + "</td>" +
        '<td class="' + (p.beerRoomBoost >= 0 ? "pos" : "neg") + '">' + signed(p.beerRoomBoost) + "</td>" +
        '<td class="' + (p.fifteenForFifteen >= 0 ? "pos" : "neg") + '">' + signed(p.fifteenForFifteen) + "</td>" +
        '<td class="' + (p.polarBear >= 0 ? "pos" : "neg") + '">' + signed(p.polarBear) + "</td>" +
        '<td class="' + (p.whoseHouse >= 0 ? "pos" : "neg") + '">' + signed(p.whoseHouse) + "</td>" +
        '<td class="' + (p.happyHour >= 0 ? "pos" : "neg") + '">' + signed(p.happyHour) + "</td>" +
        '<td class="final">' + fmt(p.net) + arrow + "</td>";

      var dt = document.createElement("tr");
      dt.className = "detail";
      dt.hidden = openDetailId !== p.id;
      dt.innerHTML = '<td colspan="12"><div class="detail-grid">' +
        '<div><b>Rank</b>#' + p.rank + " of " + people.length + "</div>" +
        '<div><b>Role</b>' + escapeHtml(p.role || "—") + "</div>" +
        '<div><b>Tier</b>' + p.tierText + "</div>" +
        '<div><b>Points</b>' + fmt(p.points) + "</div>" +
        '<div><b>Shot O\'Clock</b>×' + fmt(p.shotOClock) + "</div>" +
        "</div>" +
        '<div class="formula">((' + fmt(p.points) + " + " + fmt(p.beerRoomBoost) + " + " + fmt(p.fifteenForFifteen) +
        ") × " + fmt(p.shotOClock) + ") " +
        (p.polarBear >= 0 ? "+" : "−") + " " + fmt(Math.abs(p.polarBear)) + " " +
        (p.whoseHouse >= 0 ? "+" : "−") + " " + fmt(Math.abs(p.whoseHouse)) + " " +
        (p.happyHour >= 0 ? "+" : "−") + " " + fmt(Math.abs(p.happyHour)) +
        " = " + fmt(p.net) + "</div></td>";

      var toggle = function () {
        openDetailId = openDetailId === p.id ? null : p.id;
        renderLeaderboard();
      };
      tr.addEventListener("click", toggle);
      tr.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });

      body.appendChild(tr);
      body.appendChild(dt);
    });
    previousRank = newRank;
    return people;
  }

  function renderTicker(people) {
    if (!people.length) {
      byId("ticker-track").textContent = "Add some Pageboys to get the board started — spe labor levis, et spe vinum gravis.";
      return;
    }
    var top = people[0];
    var latest = (state.activityLog || [])[0];
    var bits = [
      "🏆 " + top.name + " leads as " + top.tierText,
      people.length + " Pageboy" + (people.length === 1 ? "" : "s") + " tracked",
      "Spe labor levis, et spe vinum gravis",
    ];
    if (latest) bits.push(latest.text);
    byId("ticker-track").textContent = bits.join("  •  ");
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
      return '<li class="activity-item">' + escapeHtml(e.text) +
        '<span class="activity-time">' + new Date(e.timestamp).toLocaleString() + "</span></li>";
    }).join("");
  }

  function renderAdminSelects() {
    var people = (state.people || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    var personOptions = people.map(function (p) {
      return '<option value="' + escapeAttr(p.id) + '">' + escapeHtml(p.name) + "</option>";
    }).join("");

    byId("boost-target").innerHTML = (people.length ? '<option value="everyone">Everyone</option>' : "") +
      (personOptions || '<option value="">No people yet</option>');
    byId("reset-target").innerHTML = (people.length ? '<option value="everyone">Everyone</option>' : "") +
      (personOptions || '<option value="">No people yet</option>');
    byId("remove-person-select").innerHTML = personOptions || '<option value="">No people yet</option>';
  }

  function renderAll() {
    var people = renderLeaderboard();
    renderTicker(people);
    renderActivity();
    renderAdminSelects();
  }

  // ---------- admin actions ----------

  function requireAdmin() {
    if (!isAdmin) { alert("Admin is locked."); return false; }
    return true;
  }

  function newPerson(name, role) {
    return {
      id: uid(), name: name, role: role || "",
      points: 5, shotOClock: 1, beerRoomBoost: 0, fifteenForFifteen: 0,
      polarBear: 0, whoseHouse: 0, happyHour: 0,
    };
  }

  function applyBoost(targetId, category, amount, reason) {
    var targets = targetId === "everyone" ? state.people : [personById(targetId)].filter(Boolean);
    targets.forEach(function (p) { p[category] = round2((p[category] || 0) + amount); });
    var label = CATEGORY_LABELS[category];
    var who = targetId === "everyone" ? "everyone" : (personById(targetId) || {}).name || "someone";
    logActivity(
      label + " " + signed(amount) + " for " + who + (reason ? " — " + reason : "")
    );
  }

  function resetBoosts(targetId) {
    var targets = targetId === "everyone" ? state.people : [personById(targetId)].filter(Boolean);
    targets.forEach(function (p) {
      RESETTABLE.forEach(function (cat) { p[cat] = 0; });
      p.shotOClock = 1;
    });
    var who = targetId === "everyone" ? "everyone" : (personById(targetId) || {}).name || "someone";
    logActivity("Boosts reset for " + who);
  }

  function addPerson(name, role) {
    state.people.push(newPerson(name, role));
    logActivity(name + (role ? " (" + role + ")" : "") + " joined the board");
  }

  function removePerson(personId) {
    var person = personById(personId);
    if (!person) return;
    state.people = state.people.filter(function (p) { return p.id !== personId; });
    if (openDetailId === personId) openDetailId = null;
    logActivity(person.name + " was removed from the board");
  }

  // ---------- admin UI wiring ----------

  function unlockAdmin() {
    isAdmin = true;
    byId("admin-locked").hidden = true;
    byId("admin-unlocked").hidden = false;
  }
  function lockAdmin() {
    isAdmin = false;
    adminCode = null;
    sessionStorage.removeItem("phpAdminCode");
    byId("admin-locked").hidden = false;
    byId("admin-unlocked").hidden = true;
  }

  function wireAdminForms() {
    byId("admin-login-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var code = byId("admin-code").value;
      var btn = ev.target.querySelector("button[type=submit]");
      byId("admin-login-error").hidden = true;
      if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
      // The real check only ever happens server-side, against a salted
      // hash Code.gs holds — this file never contains the code to
      // compare against locally. verifyOnly asks Code.gs to check the
      // code without writing anything, just so a wrong code can be
      // reported back immediately instead of silently failing on the
      // next real action.
      fetch(STORE_URL, { method: "POST", body: JSON.stringify({ auth: code, verifyOnly: true }) })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data && data.status === "ok") {
            adminCode = code;
            sessionStorage.setItem("phpAdminCode", adminCode);
            byId("admin-code").value = "";
            unlockAdmin();
          } else {
            byId("admin-login-error").textContent = data && data.error === "Too many failed attempts — locked for a few minutes"
              ? "Too many wrong attempts — locked for a few minutes."
              : "That's not the code.";
            byId("admin-login-error").hidden = false;
          }
        })
        .catch(function (err) {
          console.error(err);
          byId("admin-login-error").textContent = "Couldn't reach the server — try again.";
          byId("admin-login-error").hidden = false;
        })
        .finally(function () {
          if (btn) { btn.disabled = false; btn.textContent = "Unlock admin"; }
        });
    });
    byId("admin-lock-btn").addEventListener("click", lockAdmin);

    Array.prototype.forEach.call(document.querySelectorAll(".preset-btn"), function (btn) {
      btn.addEventListener("click", function () {
        byId("boost-category").value = btn.dataset.cat;
        byId("boost-amount").value = btn.dataset.amt;
      });
    });

    byId("apply-boost-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!requireAdmin()) return;
      var target = byId("boost-target").value;
      var category = byId("boost-category").value;
      var amount = parseFloat(byId("boost-amount").value);
      var reason = byId("boost-reason").value.trim();
      if (!target || isNaN(amount)) return;
      applyBoost(target, category, amount, reason);
      byId("boost-reason").value = "";
      renderAll();
      withSavingUi(saveState(), ev.target);
    });

    byId("reset-boosts-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!requireAdmin()) return;
      var target = byId("reset-target").value;
      if (!target) return;
      if (!confirm("Reset boosts for " + (target === "everyone" ? "everyone" : (personById(target) || {}).name) + "?")) return;
      resetBoosts(target);
      renderAll();
      withSavingUi(saveState(), ev.target);
    });

    byId("add-person-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!requireAdmin()) return;
      var name = byId("person-name").value.trim();
      var role = byId("person-role").value.trim();
      if (!name) return;
      addPerson(name, role);
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

  // ---------- decorative bouncing excomm photos ----------

  function wireFloaters() {
    var colors = ["var(--gold)", "var(--pink)", "var(--cyan)", "var(--violet)", "var(--up)"];
    var faces = Array.prototype.map.call(document.querySelectorAll(".floater"), function (el, i) {
      var hue = Math.floor(Math.random() * 360);
      el.style.filter = "hue-rotate(" + hue + "deg) saturate(1.6)";
      return {
        el: el, hue: hue,
        x: Math.random() * Math.max(1, innerWidth - 120), y: Math.random() * Math.max(1, innerHeight - 120),
        vx: (i % 2 ? -1 : 1) * (1.4 + i * 0.35), vy: (i % 2 ? 1 : -1) * (1.1 + i * 0.3),
      };
    });
    if (!faces.length) return;
    var slow = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.35 : 1;
    var ci = 0, last = performance.now();
    function step(t) {
      var dt = Math.min(3, (t - last) / 16.67) * slow;
      last = t;
      faces.forEach(function (f) {
        var el = f.el, w = innerWidth - el.offsetWidth, h = innerHeight - el.offsetHeight;
        f.x += f.vx * dt; f.y += f.vy * dt;
        var hit = false;
        if (f.x <= 0) { f.x = 0; f.vx = Math.abs(f.vx); hit = true; }
        else if (f.x >= w) { f.x = w; f.vx = -Math.abs(f.vx); hit = true; }
        if (f.y <= 0) { f.y = 0; f.vy = Math.abs(f.vy); hit = true; }
        else if (f.y >= h) { f.y = h; f.vy = -Math.abs(f.vy); hit = true; }
        if (hit) {
          // DVD-logo-style: pick a new color on every bounce and hold it
          // (not a slow continuous drift) — applied as a filter on the
          // photo itself, not just its border, so the whole image tints.
          ci = (ci + 1) % colors.length;
          el.style.borderColor = colors[ci];
          f.hue = (f.hue + 55 + Math.floor(Math.random() * 40)) % 360;
          el.style.filter = "hue-rotate(" + f.hue + "deg) saturate(1.6)";
          el.classList.remove("corner"); void el.offsetWidth; el.classList.add("corner");
        }
        el.style.transform = "translate(" + f.x + "px," + f.y + "px)";
      });
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ---------- boot ----------

  function refresh() {
    return fetchState()
      .then(renderAll)
      .then(function () { byId("sync-status").textContent = "Synced " + fmtClock(new Date()); })
      .catch(function (err) {
        console.error(err);
        byId("sync-status").textContent = "Couldn't load — retrying…";
      });
  }

  document.addEventListener("DOMContentLoaded", function () {
    wireTheme();

    if (!STORE_URL) {
      byId("setup-screen").hidden = false;
      return;
    }

    byId("main-layout").hidden = false;
    wireAdminForms();
    wireFloaters();
    // Optimistic only: a stored adminCode just means this tab passed a
    // verifyOnly check earlier in the session, not that it's still
    // valid right now. Code.gs re-checks the hash on every real write
    // and saveState() calls lockAdmin() if one comes back Unauthorized.
    if (isAdmin) unlockAdmin();

    byId("refresh-btn").addEventListener("click", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refresh();
    });

    refresh();
    setInterval(refresh, POLL_MS);
  });
})();
