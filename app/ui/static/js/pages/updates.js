/* Settings > Updates: what is installed, what is published, installing it.

   The card at the top always says one thing - checking, up to date, a version
   to install, installing, waiting for a restart, or what went wrong - and
   carries the one button that state calls for. */

import { api, health, reloadWhenBack } from "../core/api.js";
import { $, escapeHtml, getVal, on } from "../core/dom.js";
import { KEYS, store } from "../core/storage.js";
import { confirmModal, showToast } from "../core/ui.js";
import { saveFormState } from "../generator/draft.js";

const KEPT = "Your settings, lists and macros are kept.";
const NOT_BACK = "TickAssist didn't come back by itself - start it again from its shortcut.";

let info = null;          // the last /api/update/check answer
let busy = false;         // installing or restarting: nothing else may start
let versionsLoaded = false;

/* ---- the card --------------------------------------------------------------- */
// state: checking | current | available | working | restart | error
function card(state, headline, detail = "", action = "") {
  const el = $("upd-card");
  if (!el) return;
  el.dataset.state = state;
  $("upd-headline").textContent = headline;
  $("upd-detail").textContent = detail;
  const install = $("btn-upd-install");
  install.classList.toggle("hidden", !action);
  if (action) install.textContent = action;
  install.disabled = busy;
  $("btn-upd-check").disabled = busy || state === "checking";
  $("btn-upd-check").classList.toggle("hidden", state === "working" || state === "restart");
  if ($("btn-upd-version")) $("btn-upd-version").disabled = busy || !$("upd-versions").value;
}

function checkedAt() {
  return "Checked " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + ".";
}

// Release notes are a short piece of Markdown: bullets (wrapped over several
// lines), "### headings", `code` and **bold**.
function notesHtml(text) {
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const blocks = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const last = blocks[blocks.length - 1];
    if (!line) { blocks.push(null); continue; }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    const head = line.match(/^#{1,6}\s+(.*)$/);
    if (bullet) blocks.push({ kind: "li", text: bullet[1] });
    else if (head) blocks.push({ kind: "h", text: head[1] });
    else if (last && last.kind !== "h") last.text += " " + line;      // a wrapped line
    else blocks.push({ kind: "p", text: line });
  }
  let html = "", inList = false;
  for (const b of blocks.filter(Boolean)) {
    if (inList && b.kind !== "li") { html += "</ul>"; inList = false; }
    if (b.kind === "li") { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(b.text)}</li>`; }
    else html += b.kind === "h" ? `<h4>${inline(b.text)}</h4>` : `<p>${inline(b.text)}</p>`;
  }
  return html + (inList ? "</ul>" : "");
}

function showNotes(version, text, open) {
  const box = $("upd-notes");
  if (!box) return;
  const html = notesHtml(text);
  box.classList.toggle("hidden", !html);
  $("upd-notes-version").textContent = version || "";
  $("upd-notes-body").innerHTML = html;
  box.open = !!open;
}

function render() {
  const newer = info.newer && !info.restart_needed;
  const chip = $("update-chip");
  chip.classList.toggle("hidden", !newer);
  if (newer) chip.textContent = `Update ${info.latest} available`;
  if (info.restart_needed) {
    card("restart", `Version ${info.current} is installed`,
      "TickAssist is still running the version before it. Restart to finish the update.", "Restart now");
  } else if (newer) {
    card("available", `Version ${info.latest} is available`, `You have ${info.current}. ${KEPT}`,
      `Install ${info.latest} and restart`);
  } else {
    card("current", "TickAssist is up to date", `Version ${info.current} is the newest. ${checkedAt()}`);
  }
  showNotes(info.latest, info.notes, newer);
}

function failed(err) {
  card("error", "Couldn't check for updates", err.message);
  // Where an edition with an access token keeps it: usually what is missing.
  if ($("upd-token-fold")) $("upd-token-fold").open = true;
}

// fresh: ask GitHub again even if the server has an answer from a moment ago.
async function checkUpdates(fresh) {
  if (busy) return;
  card("checking", "Checking for updates…");
  try {
    info = await api("GET", "/api/update/check" + (fresh ? "?fresh=1" : ""));
  } catch (err) { info = null; $("update-chip").classList.add("hidden"); failed(err); return; }
  if (info.auto_message && /^Updated/.test(info.auto_message)) {
    const seen = store.get(KEYS.autoUpdateSeen, true) || "";
    if (seen !== info.auto_message) {
      store.set(KEYS.autoUpdateSeen, info.auto_message, true);
      showToast(info.auto_message, "green");
    }
  }
  render();
}

/* ---- installing ------------------------------------------------------------- */
async function runningVersion() {
  try { return (await health()).info.running_version || ""; } catch (e) { return ""; }
}

// Reload once a version other than `from` is serving.
function reloadWhenNewVersion(from) {
  reloadWhenBack((h) => !!h.info.running_version && h.info.running_version !== from, {
    firstDelay: 2500,
    onGiveUp: () => { busy = false; card("error", "TickAssist didn't restart", NOT_BACK); },
  });
}

// Install (path, body), restart, and reload the page when the new copy answers.
async function install(version, path, body) {
  const from = await runningVersion();
  busy = true;
  card("working", `Installing version ${version}…`, "Downloading and checking the update.");
  try {
    saveFormState();
    const done = await api("POST", path, body);
    card("working", `Version ${done.new || version} is installed`, "Restarting TickAssist…");
    await api("POST", "/api/update/restart", {});
  } catch (err) {
    busy = false;
    card("error", `Version ${version} wasn't installed`, err.message);
    showToast(err.message, "red");
    return;
  }
  reloadWhenNewVersion(from);
}

async function restartNow() {
  const from = await runningVersion();
  busy = true;
  card("working", "Restarting TickAssist…");
  try { saveFormState(); await api("POST", "/api/update/restart", {}); }
  catch (err) { busy = false; card("error", "TickAssist didn't restart", err.message); return; }
  reloadWhenNewVersion(from);
}

async function installUpdate() {
  if (busy || !info) return;
  if (info.restart_needed) { restartNow(); return; }
  if (!info.newer) return;
  const yes = await confirmModal(`Update to version ${info.latest}?`,
    `TickAssist installs it and restarts in a few seconds. ${KEPT}`, "Install and restart");
  if (yes) install(info.latest, "/api/update/apply", {});
}

/* ---- another version ---------------------------------------------------------- */
async function loadVersions() {
  const sel = $("upd-versions");
  sel.disabled = true;
  sel.innerHTML = '<option value="">Loading versions…</option>';
  let note = "", failedLoad = false;
  try {
    const r = await api("GET", "/api/update/versions");
    sel.innerHTML = '<option value="">Choose a version…</option>' + r.versions.map((v) => {
      const here = v.version === r.current;
      return `<option value="${escapeHtml(v.version)}"${here ? " disabled" : ""}>` +
        `${escapeHtml(v.version)}${here ? " (installed)" : ""}</option>`;
    }).join("");
    versionsLoaded = true;
    const others = r.versions.filter((v) => v.version !== r.current);
    sel.disabled = !others.length;
    // Versions from before 6.4 used another update system and are not listed.
    if (!others.length) {
      sel.innerHTML = '<option value="">No other version yet</option>';
      note = `Version ${r.current} is the only one published so far. Each new version stays here to go back to.`;
    }
  } catch (err) {
    sel.innerHTML = '<option value="">No versions to show</option>';
    versionsLoaded = false;
    note = err.message;
    failedLoad = true;
  }
  const msg = $("upd-versions-msg");
  msg.textContent = note;
  msg.classList.toggle("hidden", !note);
  msg.classList.toggle("upd-problem", failedLoad);
  $("btn-upd-version").disabled = true;
}

async function installVersion() {
  const v = $("upd-versions").value;
  if (busy || !v) return;
  const yes = await confirmModal(`Install version ${v}?`,
    `TickAssist installs it and restarts in a few seconds. ${KEPT} ` +
    "Going back to an earlier version turns automatic updates off.", "Install and restart");
  if (yes) install(v, "/api/update/install-version", { version: v });
}

/* ---- the access token (an edition that updates from a private repository) -------- */
async function saveToken(token) {
  try {
    await api("POST", "/api/settings", { update_token: token });
    showToast(token ? "Access token saved" : "Access token removed", "green");
    versionsLoaded = false;
    if ($("upd-versions-fold").open) loadVersions();
    await checkUpdates(true);
    return true;
  } catch (err) { showToast(err.message, "red"); return false; }
}

let tokenSet = false;

function tokenStatus(set) {
  tokenSet = !!set;
  const out = $("upd-token-status");
  if (!out) return;
  out.textContent = set
    ? "A token is saved on this PC. Paste another to replace it, or save the empty box to remove it."
    : "No token saved yet.";
}

/* ---- what Settings loads -------------------------------------------------------- */
let checkedOnce = false;

// Called with every /api/settings answer; the first one also checks for updates.
export function fillUpdateSettings(s) {
  if ($("upd-auto")) $("upd-auto").checked = s.auto_update !== false;
  if ($("upd-version")) $("upd-version").textContent = `Version ${s.version || ""}`;
  tokenStatus(s.update_token_set);
  if (!checkedOnce) { checkedOnce = true; checkUpdates(false); }
}

/* ---- the version line --------------------------------------------------------- */
let versionClicks = [];

function versionClicked() {
  const now = Date.now();
  versionClicks = versionClicks.filter((t) => now - t < 4000).concat(now);
  if (versionClicks.length < 7) return;
  versionClicks = [];
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-label="No">' +
    '<div class="modal-emoji">\u{1F595}</div>' +
    '<div class="btn-row"><button class="btn" type="button">Close</button></div></div>';
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() { back.remove(); document.removeEventListener("keydown", onKey); }
  back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("button")) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(back);
  back.querySelector("button").focus();
}

export function initUpdates() {
  on("btn-upd-check", "click", () => checkUpdates(true));
  on("btn-upd-install", "click", installUpdate);
  on("update-chip", "click", installUpdate);
  on("upd-auto", "change", async () => {
    const wanted = $("upd-auto").checked;
    try {
      await api("POST", "/api/settings", { auto_update: wanted });
      showToast(wanted ? "Updates will install automatically" : "Automatic updates off", "indigo");
    } catch (err) { $("upd-auto").checked = !wanted; showToast(err.message, "red"); }
  });
  on("upd-versions-fold", "toggle", () => {
    if ($("upd-versions-fold").open && !versionsLoaded) loadVersions();
  });
  on("upd-versions", "change", () => { $("btn-upd-version").disabled = busy || !$("upd-versions").value; });
  on("btn-upd-version", "click", installVersion);
  on("btn-upd-token", "click", async () => {
    const token = getVal("upd-token");
    if (!token && !tokenSet) { showToast("Paste an access token first", "red"); return; }
    if (await saveToken(token)) {
      $("upd-token").value = "";
      tokenStatus(!!token);
    }
  });
  on("upd-version", "click", versionClicked);
}
