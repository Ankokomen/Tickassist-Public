/* ---- managed lists (dealers / device types / Reco units) ---------------- */

import { api } from "../core/api.js";
import { $, escapeHtml, getVal, on } from "../core/dom.js";
import { TRASH_SVG } from "../core/icons.js";
import { confirmModal, showToast } from "../core/ui.js";
import { revealFields } from "../generator/fi-steps.js";

// Each list drives a Settings add/trash panel and a generator combobox.
export const LISTS = {
  dealers: { items: [], combo: null },
  device_types: { items: [], combo: null },
  reco_units: { items: [], combo: null },
  // System Environment dropdowns
  os_versions: { items: [], combo: null }, device_firmware: { items: [], combo: null },
  device_tool_versions: { items: [], combo: null }, didapi_versions: { items: [], combo: null },
  romexis_versions: { items: [], combo: null }, imaging_packages: { items: [], combo: null },
  reco_os: { items: [], combo: null }, reco_firmware: { items: [], combo: null },
};
// list -> [input id, ticket column]: what each dropdown suggests, and what a
// save adds to it.
export const ENV_COMBOS = {
  os_versions: ["osVersion", "os_version"], device_firmware: ["deviceFirmware", "device_firmware"],
  device_tool_versions: ["deviceToolVersion", "device_tool_version"], didapi_versions: ["didapi", "didapi"],
  romexis_versions: ["romexis", "romexis"], imaging_packages: ["imagingPackage", "imaging_package"],
  reco_os: ["recoOs", "reco_os"], reco_firmware: ["recoFirmware", "reco_firmware"],
};

export async function loadList(key) {
  try {
    const data = await api("GET", `/api/lists/${key}`);
    LISTS[key].items = data.items || [];
    LISTS[key].fixed = !!data.fixed;
    LISTS[key].verified = !!data.verified;
    // A System Environment list can be switched off: its field then takes any
    // text, with nothing suggested from, checked against or added to the list.
    LISTS[key].canSwitchOff = !!data.can_switch_off;
    LISTS[key].off = !!data.off;
    renderListPanel(key);
    if (LISTS[key].combo) LISTS[key].combo.render();
    if (LISTS[key].combo2) LISTS[key].combo2.render();
  } catch (err) { showToast(err.message, "red"); }
}

/* ---- listed fields: pick from the list, never invent a value ------------------- */
// Device Type, Reco Unit and the System Environment fields only take values on
// their list. Typing "23" when the list holds 23.1.0 and 23.1.2 gets a short
// dropdown of those to choose from. Environment values that are not on the
// list yet are accepted (and added) only if a linked Google Sheet has them.
// Romexis versions are the exception: the sheets write them awkwardly, so that
// field stays free text with suggestions and a typed value is added on save.
export const FREE_LISTS = new Set(["romexis_versions"]);
const LISTED_FIELDS = [["device_types", "deviceType"], ["reco_units", "recoPc"], ["os_versions", "osVersion2"],
  ...Object.entries(ENV_COMBOS).filter(([key]) => !FREE_LISTS.has(key)).map(([key, [id]]) => [key, id])];
const LISTED_LABEL = { deviceType: "Device Type", recoPc: "Reco Unit", osVersion: "OS Version", osVersion2: "OS Version (2nd system)",
  deviceFirmware: "Device Firmware", deviceToolVersion: "Device Tool", didapi: "DIDAPI",
  romexis: "Romexis", imagingPackage: "Imaging Package", recoOs: "Reco OS", recoFirmware: "Reco Firmware" };
let loadedListed = {};          // field id -> value it had when a saved note was opened

// A saved note was opened: the values it already holds are not re-checked unless changed.
export function rememberListedValues() {
  loadedListed = {};
  LISTED_FIELDS.forEach(([, id]) => {
    loadedListed[id] = getVal(id).toLowerCase();
    if ($(id)) $(id).classList.remove("list-invalid");
  });
}
// The form was cleared: the next note is checked in full.
export function forgetListedValues() { loadedListed = {}; }
const sheetVerdict = {};        // "list|value" -> { ok, at }

function listedKey(id) { const f = LISTED_FIELDS.find((x) => x[1] === id); return f && f[0]; }

function relatedListItems(key, typed) {
  const t = typed.trim().toLowerCase();
  if (!t) return [];
  const toks = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const tt = toks(t);
  const scored = [];
  for (const it of LISTS[key].items) {
    const name = it.name.toLowerCase();
    const nt = toks(name);
    let common = 0;
    while (common < tt.length && common < nt.length && tt[common] === nt[common]) common++;
    let score = common * 10;
    if (name.startsWith(t) || t.startsWith(name)) score += 5;
    else if (name.includes(t)) score += 3;
    if (score > 0) scored.push([score, it.name]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1], undefined, { numeric: true }));
  return scored.slice(0, 6).map((s) => s[1]);
}

// "ok" | "invalid". Canonicalises the case of a match and adds a sheet-verified value.
async function checkListed(id, announce) {
  const el = $(id), key = listedKey(id);
  if (!el || !key) return "ok";
  const typed = el.value.trim();
  el.classList.remove("list-invalid");
  if (!typed || LISTS[key].off) return "ok";
  const hit = LISTS[key].items.find((it) => it.name.toLowerCase() === typed.toLowerCase());
  if (hit) { if (el.value !== hit.name) el.value = hit.name; return "ok"; }
  if (loadedListed[id] === typed.toLowerCase()) return "ok";   // unchanged on a saved note
  if (LISTS[key].verified) {
    const vk = key + "|" + typed.toLowerCase();
    const seen = sheetVerdict[vk];
    if (!seen || Date.now() - seen.at > 30000) {
      try {
        const r = await api("GET", `/api/lists/${key}/verify?value=${encodeURIComponent(typed)}`);
        sheetVerdict[vk] = { ok: !!r.verified, value: r.value, at: Date.now() };
        if (r.verified && await addListItem(key, r.value)) { if (el.value.trim().toLowerCase() === typed.toLowerCase()) el.value = r.value; return "ok"; }
      } catch (err) { sheetVerdict[vk] = { ok: false, at: Date.now() }; }
    } else if (seen.ok) { await loadList(key); return "ok"; }
  }
  el.classList.add("list-invalid");
  if (announce) {
    const names = relatedListItems(key, typed);
    const combo = id === "osVersion2" ? LISTS.os_versions.combo2 : LISTS[key].combo;
    if (combo) combo.suggest(names, names.length ? "Not on the list - pick one of these:" : "Not on the list");
  }
  return "invalid";
}

export async function unlistedFields() {
  const bad = [];
  for (const [, id] of LISTED_FIELDS) if (await checkListed(id, false) === "invalid") bad.push(id);
  return bad;
}

export function reportUnlisted(bad) {
  revealFields(bad);
  showToast("Pick from the list: " + bad.map((id) => `${LISTED_LABEL[id] || id} "${getVal(id)}"`).join(", ") +
            " (Shift+click Save to save it anyway)", "red");
  const first = $(bad[0]);
  if (first) {
    first.scrollIntoView({ block: "center", behavior: "smooth" });
    first.focus();
    checkListed(bad[0], true);
  }
}

export function initListedFields() {
  LISTED_FIELDS.forEach(([, id]) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", () => el.classList.remove("list-invalid"));
    el.addEventListener("change", () => checkListed(id, true));
  });
}

export function loadAllLists() { Object.keys(LISTS).forEach(loadList); }

function listHas(key, name) {
  const n = (name || "").trim().toLowerCase();
  return LISTS[key].items.some((it) => it.name.toLowerCase() === n);
}

// The switch and the Clear button of a System Environment list, under its title.
function renderListTools(key, panel) {
  const info = LISTS[key];
  let tools = panel.querySelector(".env-list-tools");
  if (!tools) {
    tools = document.createElement("div");
    tools.className = "env-list-tools";
    panel.querySelector(".env-list-title").after(tools);
  }
  const title = panel.querySelector(".env-list-title").textContent.trim();
  tools.innerHTML =
    `<label class="env-list-switch" title="Off: the field in the note takes any text, and this list is not used at all">` +
    `<input type="checkbox" class="switch" data-list-switch="${key}"${info.off ? "" : " checked"}` +
    ` aria-label="Use the ${escapeHtml(title)} list"><span>${info.off ? "Off" : "On"}</span></label>` +
    (info.fixed ? "" : `<button type="button" class="btn small" data-list-clear="${key}"` +
      `${info.items.length ? "" : " disabled"} title="Remove every entry of this list">Clear list</button>`);
  panel.classList.toggle("off", info.off);
}

function renderListPanel(key) {
  const list = document.querySelector(`[data-list="${key}"]`);
  if (!list) return;
  const fixed = LISTS[key].fixed, off = LISTS[key].off;
  const panel = list.closest(".env-list-panel");
  if (panel && LISTS[key].canSwitchOff) renderListTools(key, panel);
  // A fixed list has no Add row and no Remove buttons: only an update changes it.
  const add = document.querySelector(`[data-list-add="${key}"]`);
  if (add && add.closest(".managed-add")) add.closest(".managed-add").classList.toggle("hidden", fixed || off);
  if (off) {
    const n = LISTS[key].items.length;
    list.innerHTML = '<div class="empty">Switched off. The field in the note takes any text; nothing is ' +
      "suggested from, checked against or added to this list." +
      (n ? ` Its ${n} entr${n === 1 ? "y is" : "ies are"} kept for when it is switched on again.` : "") + "</div>";
    return;
  }
  list.innerHTML = LISTS[key].items.length
    ? LISTS[key].items.map((it) => `
      <div class="managed-row">
        <span class="name">${escapeHtml(it.name)}</span>
        ${fixed ? "" : `<button class="icon-btn" data-list-del="${key}" data-id="${it.id}" title="Remove">${TRASH_SVG}</button>`}
      </div>`).join("") +
      (fixed ? '<div class="field-help">Fixed list - new entries arrive with a TickAssist update.</div>' : "")
    : `<div class="empty">${fixed ? "Empty." : "Nothing here yet. Add one above."}</div>`;
}

// Returns true on success; shows its own error toast on failure.
async function addListItem(key, name) {
  name = (name || "").trim();
  if (!name) { showToast("Enter a value first", "red"); return false; }
  try {
    await api("POST", `/api/lists/${key}`, { name });
    await loadList(key);
    return true;
  } catch (err) { showToast(err.message, "red"); return false; }
}

async function deleteListItem(key, id) {
  const ok = await confirmModal("Remove this entry?", "It will be removed from the list.", "Remove");
  if (!ok) return;
  try {
    await api("DELETE", `/api/lists/${key}/${id}`);
    showToast("Removed", "slate");
    loadList(key);
  } catch (err) { showToast(err.message, "red"); }
}

async function switchList(key, on) {
  try {
    await api("POST", `/api/lists/${key}/switch`, { on });
    showToast(on ? "List switched on" : "List switched off - its field takes any text", "indigo");
  } catch (err) { showToast(err.message, "red"); }
  loadList(key);
}

async function clearList(key) {
  const n = LISTS[key].items.length;
  const panel = document.querySelector(`[data-list="${key}"]`).closest(".env-list-panel");
  const title = panel ? panel.querySelector(".env-list-title").textContent.trim() : "this list";
  const ok = await confirmModal(`Clear ${title}?`,
    `All ${n} entr${n === 1 ? "y" : "ies"} will be removed from the list. Notes already saved keep what they say.` +
    (LISTS[key].off ? "" : " To keep it from filling up again, switch the list off as well."), "Clear list");
  if (!ok) return;
  try {
    const r = await api("DELETE", `/api/lists/${key}`);
    showToast(`Removed ${r.removed} entr${r.removed === 1 ? "y" : "ies"}`, "slate");
  } catch (err) { showToast(err.message, "red"); }
  loadList(key);
}

// Register a value typed straight into a ticket field into its list on save.
export async function autoRegister(key, value) {
  const name = (value || "").trim();
  if (!name || LISTS[key].off || listHas(key, name)) return;
  try { await api("POST", `/api/lists/${key}`, { name }); await loadList(key); }
  catch (err) { /* duplicate / race - ignore */ }
}

// Settings > Lists: import from the sheets, and the add / remove panels.
export function initListPanels() {
  on("btn-lists-import", "click", async () => {
    const btn = $("btn-lists-import"), out = $("lists-import-status");
    btn.disabled = true; out.textContent = "Reading your sheets...";
    try {
      const r = await api("POST", "/api/lists/sync", {});
      out.textContent = r.total ? `Added ${r.total} value${r.total === 1 ? "" : "s"} from your sheets.`
                                : "Everything in your sheets is already on the lists.";
      loadAllLists();
    } catch (err) { out.textContent = err.message; }
    btn.disabled = false;
  });
  document.querySelectorAll("[data-list-addbtn]").forEach((btn) => {
    const key = btn.dataset.listAddbtn;
    const input = document.querySelector(`[data-list-add="${key}"]`);
    const add = async () => {
      if (await addListItem(key, input.value)) { input.value = ""; showToast("Added", "green"); input.focus(); }
    };
    btn.addEventListener("click", add);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  });
  document.querySelectorAll("[data-list]").forEach((container) => {
    container.addEventListener("click", (e) => {
      const del = e.target.closest("[data-list-del]");
      if (del) deleteListItem(del.dataset.listDel, del.dataset.id);
    });
  });
  // The switch and Clear of each System Environment list (drawn by renderListTools).
  const env = $("env-lists-panel");
  if (env) {
    env.addEventListener("change", (e) => {
      const sw = e.target.closest("[data-list-switch]");
      if (sw) switchList(sw.dataset.listSwitch, sw.checked);
    });
    env.addEventListener("click", (e) => {
      const clear = e.target.closest("[data-list-clear]");
      if (clear) clearList(clear.dataset.listClear);
    });
  }
}
