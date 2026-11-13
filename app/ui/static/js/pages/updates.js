/* Settings > Updates: checking, installing, other versions. */

import { api, health, reloadWhenBack } from "../core/api.js";
import { $, getVal, on } from "../core/dom.js";
import { hook } from "../core/hooks.js";
import { KEYS, store } from "../core/storage.js";
import { showToast } from "../core/ui.js";
import { saveFormState } from "../generator/draft.js";

/* ---- program updates -------------------------------------------------------- */
let updateChecked = false;

// The first settings load with an update address checks it, once per page.
export function checkUpdatesOnce(url) {
  if (updateChecked || !url) return;
  updateChecked = true;
  checkUpdates(true);
}
let updateInfo = null;

function updStatus(text, state) {
  const out = $("upd-status");
  if (!out) return;
  out.classList.toggle("hidden", !text);
  out.dataset.state = state || "";
  out.textContent = text || "";
}

async function checkUpdates(silent) {
  if (!silent) updStatus("Checking...", "");
  try {
    updateInfo = await api("GET", "/api/update/check");
    if (updateInfo.auto_message && /^Updated/.test(updateInfo.auto_message)) {
      const seen = store.get(KEYS.autoUpdateSeen, true) || "";
      if (seen !== updateInfo.auto_message) {
        store.set(KEYS.autoUpdateSeen, updateInfo.auto_message, true);
        showToast(updateInfo.auto_message, "green");
      }
    }
  } catch (err) {
    if (!silent) updStatus(err.message, "error");
    return;
  }
  const newer = updateInfo.newer && !updateInfo.restart_needed;
  $("update-chip").classList.toggle("hidden", !newer);
  $("btn-upd-install").classList.toggle("hidden", !newer);
  if (newer) {
    $("update-chip").textContent = `Update ${updateInfo.latest} available`;
    $("btn-upd-install").textContent = `Install ${updateInfo.latest} and restart`;
  }
  if (!silent || newer) {
    updStatus(newer
      ? `Version ${updateInfo.latest} is available (you have ${updateInfo.current}).${updateInfo.notes ? " " + updateInfo.notes : ""}`
      : `You're up to date (version ${updateInfo.current}).`, newer ? "" : "running");
  }
}

async function installUpdate() {
  if (!updateInfo || !updateInfo.newer) return;
  const takeOver = hook("installUpdate");
  if (takeOver) { takeOver(updateInfo); return; }
  if (!confirm(`Update TickAssist to ${updateInfo.latest}?\n\nIt will restart in a few seconds. ` +
               `Your settings, lists and macros are kept.`)) return;
  updStatus("Downloading and installing...", "");
  try {
    saveFormState();
    await api("POST", "/api/update/apply", {});
    updStatus("Installed. Restarting...", "running");
    await api("POST", "/api/update/restart", {});
  } catch (err) {
    updStatus(err.message, "error");
    showToast(err.message, "red");
    return;
  }
  // The old copy is closing and the new one is starting; reload when it answers.
  reloadWhenNewVersion(updateInfo.current);
}

const NOT_BACK = "TickAssist didn't come back by itself - start it again from its shortcut.";

// Reload once a version other than `from` is serving.
function reloadWhenNewVersion(from) {
  reloadWhenBack((h) => !!h.info.running_version && h.info.running_version !== from,
    { firstDelay: 2500, onGiveUp: () => updStatus(NOT_BACK, "error") });
}

async function loadVersions() {
  const sel = $("upd-versions");
  updStatus("Loading versions...", "");
  try {
    const r = await api("GET", "/api/update/versions");
    sel.innerHTML = '<option value="">Choose a version...</option>' + r.versions.map((v) =>
      `<option value="${v.version}">${v.version}${v.version === r.current ? " (installed)" : ""}${v.notes ? " - " + v.notes.slice(0, 70).replace(/</g, "&lt;") : ""}</option>`).join("");
    $("btn-upd-version").classList.remove("hidden");
    updStatus(r.versions.length ? "Pick a version, then install it." : "No versions are listed.", "");
  } catch (err) { updStatus(err.message, "error"); }
}

async function installVersion() {
  const v = $("upd-versions").value;
  if (!v) { showToast("Choose a version first", "red"); return; }
  let from = "";
  try { from = (await health()).info.running_version || ""; } catch (e) { /* ignore */ }
  if (!confirm(`Install TickAssist ${v}?\n\nIt will restart in a few seconds. Your settings, lists and macros are kept.`)) return;
  updStatus("Downloading and installing " + v + "...", "");
  try {
    saveFormState();
    await api("POST", "/api/update/install-version", { version: v });
    updStatus("Installed. Restarting...", "running");
    await api("POST", "/api/update/restart", {});
  } catch (err) { updStatus(err.message, "error"); showToast(err.message, "red"); return; }
  reloadWhenNewVersion(from);
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
  on("btn-upd-load", "click", loadVersions);
  on("btn-upd-version", "click", installVersion);
  on("btn-upd-save", "click", async () => {
    try {
      await api("POST", "/api/settings", { update_url: getVal("upd-url") });
      showToast("Update address saved", "green");
      await checkUpdates(false);
    } catch (err) { updStatus(err.message, "error"); }
  });
  on("btn-upd-check", "click", () => checkUpdates(false));
  on("upd-auto", "change", async () => {
    try {
      await api("POST", "/api/settings", { auto_update: $("upd-auto").checked });
      showToast($("upd-auto").checked ? "Updates will install automatically" : "Automatic updates off", "indigo");
    } catch (err) { updStatus(err.message, "error"); }
  });
  on("btn-upd-install", "click", installUpdate);
  on("update-chip", "click", installUpdate);
  on("upd-version", "click", versionClicked);
}
