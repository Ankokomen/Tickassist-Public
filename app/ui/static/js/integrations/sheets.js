/* Google Sheets: lookups that fill the note, the sheet list in Settings, and the cross-check. */

import { api } from "../core/api.js";
import { $, escapeHtml, fireInput, getVal, on } from "../core/dom.js";
import { showToast } from "../core/ui.js";
import { featureOn } from "../features.js";
import { renderEnvSummary, revealEnvIfFilled, setEnvCollapsed } from "../generator/env-section.js";
import { FIELD_MAP } from "../generator/fields.js";
import { update } from "../generator/preview.js";
import { drawerDirty, markDrawerClean, markDrawerDirty } from "./drawers.js";
import { renderIntegrations } from "./status.js";
import { loadSettings, settingsCache } from "../pages/settings.js";

async function saveSheetSettings() {
  try {
    await api("POST", "/api/settings", {
      sheet_sources: collectSheetSources(),
      sheet_check: $("sheet-check-on").checked,
    });
    // A new link or mapping deserves a fresh look at what is in the note.
    sheetLast = {};
    sheetHealth = null;
    markDrawerClean("sheet");
    showToast("Google Sheets saved", "green");
    loadSettings();
  } catch (err) { showToast(err.message, "red"); }
}

// The sheet is only read on a lookup or a Test, so its health is whatever the
// last of those found: { rows } after a good Test, { error } after a failure.
export let sheetHealth = null;

/* ---- Google Sheet lookup ------------------------------------------------- */
// Typing an Imaging Package number looks it up (server-side, sheets.py) in the
// shared Google Sheet and fills the other fields from that row. By default only
// empty fields are filled, so nothing the user typed is overwritten. Found rows
// fill quietly while typing; "not in the sheet" is only reported once the field
// is left, so half-typed numbers don't nag.
let sheetTimers = {};
let sheetToken = {};
let sheetLast = {};   // lookup field -> the value last looked up

export function setFieldFromSheet(id, value, overwrite) {
  const el = $(id);
  if (!el || !value) return false;
  if (el.value.trim() && !overwrite) return false;
  if (el.tagName === "SELECT") {
    const opt = [...el.options].find((o) =>
      o.value.toLowerCase() === value.toLowerCase() || o.text.toLowerCase() === value.toLowerCase());
    if (!opt || el.value === opt.value) return false;
    el.value = opt.value;
  } else {
    if (el.value === value) return false;
    el.value = value;
  }
  fireInput(el);
  return true;
}

// Put one sheet row's values into the form; returns the labels of what changed.
function applySheetValues(values, overwrite, keyId = "imagingPackage") {
  const filled = [];
  for (const [field, value] of Object.entries(values || {})) {
    const id = FIELD_MAP[field];
    if (!id || id === keyId) continue;
    // The dealer box only exists for a Dealer contact; don't fill what's hidden.
    if (field === "dealer_name" && getVal("contactType") !== "Dealer") continue;
    if (setFieldFromSheet(id, value, overwrite)) {
      const el = $(id);
      filled.push((el && el.placeholder) || id);
    }
  }
  if (filled.length) { update(); revealEnvIfFilled(); renderEnvSummary(); }
  return filled;
}

// The same package number can sit in more than one section of the sheet (e.g.
// Promax packages at the top and a "Viso Package" block lower down). The row
// that fits the Device Type is used; the others are offered under the field.
let sheetAlts = [];
// A Device Type that already names the product line (Promax / Viso) has settled
// which section applies, so the offer stays out of the way.
function sheetDeviceSettled() { return /promax|viso/i.test(getVal("deviceType")); }

function renderSheetAlternatives(alts) {
  if (alts !== undefined) sheetAlts = alts || [];
  const box = $("sheet-alt");
  if (!box) return;
  box.textContent = "";
  const show = sheetAlts.length && !sheetDeviceSettled();
  box.classList.toggle("hidden", !show);
  if (!show) return;
  sheetAlts.forEach((alt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small";
    btn.textContent = `Use ${alt.section}`;
    btn.title = `Same number found in "${alt.section}" (sheet row ${alt.row}) - fill from that row instead`;
    btn.addEventListener("click", () => {
      const filled = applySheetValues(alt.values, true);
      showToast(filled.length ? `Filled from ${alt.section}: ${filled.join(", ")}`
                              : `Nothing to change from ${alt.section}`, "indigo");
      sheetRow = { key: getVal("imagingPackage"), section: alt.section, values: alt.values || {} };
      applySheetCheck();
      renderSheetAlternatives([]);
    });
    box.appendChild(btn);
  });
}

// Which TickAssist fields a sheet can be looked up by. Each sheet in Settings
// picks one; typing in that field reads every sheet keyed by it.
const SHEET_KEY_FIELDS = [
  ["imaging_package", "Imaging Package"], ["serial_number", "Serial Number"],
  ["device_type", "Device Type"], ["case_number", "Case ID"], ["phone", "Phone"],
  ["dealer_name", "Dealer"], ["contact", "Contact"],
];
function sheetKeyLabel(f) { return (SHEET_KEY_FIELDS.find((x) => x[0] === f) || [f, f])[1]; }
function sheetSourcesList() { return (settingsCache && settingsCache.sheet_sources) || []; }

export async function sheetLookup(announceMiss, checkOnly = false, field = "imaging_package") {
  if (!featureOn("sheet")) return;
  const id = FIELD_MAP[field];
  const isPkg = field === "imaging_package";
  const key = getVal(id);
  const label = sheetKeyLabel(field);
  if (!sheetSourcesList().some((s) => s.key_field === field && s.url)) {
    if (isPkg) { sheetRow = null; applySheetCheck(); renderSheetAlternatives([]); }
    return;
  }
  if (key.length < 2) {
    sheetLast[field] = "";
    if (isPkg) { sheetRow = null; applySheetCheck(); renderSheetAlternatives([]); }
    return;
  }
  if (!checkOnly && key === sheetLast[field] && !announceMiss) return;
  const token = (sheetToken[field] = (sheetToken[field] || 0) + 1);
  let res;
  try {
    res = await api("GET", `/api/sheet/lookup?field=${field}&key=${encodeURIComponent(key)}` +
      "&prefer=" + encodeURIComponent(getVal("deviceType")));
  } catch (err) {
    if (checkOnly) return;
    if (token === sheetToken[field] && key !== sheetLast[field]) showToast("Sheet lookup: " + err.message, "red");
    sheetLast[field] = key;
    sheetHealth = { error: err.message };
    renderIntegrations();
    return;
  }
  if (token !== sheetToken[field] || key !== getVal(id)) return; // typed on since
  if (!res.configured) return;
  sheetLast[field] = key;
  if (sheetHealth && sheetHealth.error) { sheetHealth = null; renderIntegrations(); }
  const results = res.results || [];
  const found = results.filter((r) => r.found);
  const first = found[0];
  if (isPkg) {
    sheetRow = first ? { key, section: first.section, values: first.values || {} } : null;
    applySheetCheck();
  }
  if (checkOnly) return;   // reopened note: compare only, fill nothing
  if (isPkg) renderSheetAlternatives(first ? first.alternatives : []);
  results.filter((r) => r.error).forEach((r) => showToast(`${r.source}: ${r.error}`, "red"));
  if (!found.length) {
    if (announceMiss) showToast(`${label} ${key} isn't in the sheet${results.length > 1 ? "s" : ""}`, "amber");
    return;
  }
  const filled = [], names = [];
  found.forEach((r) => {
    const f = applySheetValues(r.values, r.overwrite, id);
    if (f.length) { filled.push(...f); names.push(r.source); }
  });
  if (!filled.length) {
    if (announceMiss) showToast(`${label} ${key}: nothing new to fill from the sheets`, "indigo");
    return;
  }
  const more = isPkg && first && (first.alternatives || []).length
    ? " - also found in another section, see the button by the OS options" : "";
  showToast(`Filled from ${names.join(" + ")} (${key}): ${[...new Set(filled)].join(", ")}${more}`, "indigo");
}

/* ---- the sheet list in Settings --------------------------------------------- */
export function renderSheetSources(list) {
  const box = $("sheet-sources");
  if (!box) return;
  if (!list.length) { box.innerHTML = '<div class="empty">No sheets yet. Add one below.</div>'; return; }
  box.innerHTML = list.map((s, i) => `
    <div class="sheet-src" data-idx="${i}">
      <div class="sheet-src-head">
        <input class="input ss-name" type="text" placeholder="Name (e.g. Imaging packages)" value="${escapeHtml(s.name)}" autocomplete="off">
        <button class="btn small ss-del" type="button" title="Remove this sheet">Remove</button>
      </div>
      <label class="label">Sheet link</label>
      <input class="input ss-url" type="text" placeholder="https://docs.google.com/spreadsheets/d/..." value="${escapeHtml(s.url)}" autocomplete="off" spellcheck="false">
      <div class="sheet-src-row">
        <div><label class="label">Look it up by this field</label>
          <select class="select ss-field">${SHEET_KEY_FIELDS.map(([f, l]) =>
            `<option value="${f}"${f === s.key_field ? " selected" : ""}>${l}</option>`).join("")}</select></div>
        <div><label class="label">...which is this sheet column</label>
          <input class="input ss-col" type="text" placeholder="${escapeHtml(sheetKeyLabel(s.key_field))}" value="${escapeHtml(s.key_column)}" autocomplete="off"></div>
      </div>
      <label class="label">Column mapping (optional)</label>
      <textarea class="textarea mono small ss-map" rows="3" spellcheck="false" placeholder="Sheet column = TickAssist field, one per line&#10;Windows = os_version">${escapeHtml(s.map)}</textarea>
      <label class="check-row"><input type="checkbox" class="ss-over"${s.overwrite ? " checked" : ""}>
        <span>Replace fields that already have text (default: only fill empty ones)</span></label>
      <div class="btn-row"><button class="btn small ss-test" type="button">Test</button></div>
      <div class="cw-status hidden ss-status" role="status"></div>
    </div>`).join("");
}

function collectSheetSources() {
  return [...document.querySelectorAll("#sheet-sources .sheet-src")].map((c) => ({
    name: c.querySelector(".ss-name").value.trim(),
    url: c.querySelector(".ss-url").value.trim(),
    key_field: c.querySelector(".ss-field").value,
    key_column: c.querySelector(".ss-col").value.trim(),
    map: c.querySelector(".ss-map").value,
    overwrite: c.querySelector(".ss-over").checked,
  }));
}

export function initSheet() {
  // Typing Promax/Viso in Device Type hides the offer; clearing it brings it back.
  on("deviceType", "input", () => renderSheetAlternatives());
  // Which sheet column / section applies depends on the Device Type, so look
  // the package up again when it changes (fills empty fields only).
  on("deviceType", "change", () => {
    if (!getVal("imagingPackage")) return;
    sheetLast.imaging_package = "";
    sheetLookup(false, false, "imaging_package");
  });
  // Every field a sheet can be keyed by watches for typing; sheetLookup does
  // nothing unless a sheet is keyed by that field.
  SHEET_KEY_FIELDS.forEach(([field]) => {
    const box = $(FIELD_MAP[field]);
    if (!box) return;
    box.addEventListener("input", () => {
      if (field === "imaging_package") {
        sheetRow = null; applySheetCheck();   // the old row no longer applies
        renderSheetAlternatives([]);
      }
      clearTimeout(sheetTimers[field]);
      sheetTimers[field] = setTimeout(() => sheetLookup(false, false, field), 700);
    });
    box.addEventListener("change", () => { clearTimeout(sheetTimers[field]); sheetLookup(true, false, field); });
  });
  on("btn-sheet-save", "click", saveSheetSettings);
  on("btn-sheet-add", "click", () => {
    const list = collectSheetSources();
    list.push({ name: "", url: "", key_field: "imaging_package", key_column: "", map: "", overwrite: false });
    renderSheetSources(list);
    markDrawerDirty("sheet");
    const cards = document.querySelectorAll("#sheet-sources .ss-name");
    if (cards.length) cards[cards.length - 1].focus();
  });
  const list = $("sheet-sources");
  if (list) {
    list.addEventListener("change", (e) => {
      if (!e.target.classList.contains("ss-field")) return;
      e.target.closest(".sheet-src").querySelector(".ss-col").placeholder = sheetKeyLabel(e.target.value);
    });
    list.addEventListener("click", async (e) => {
      const card = e.target.closest(".sheet-src");
      if (!card) return;
      if (e.target.closest(".ss-del")) {
        const idx = Number(card.dataset.idx);
        const all = collectSheetSources();
        all.splice(idx, 1);
        renderSheetSources(all);
        markDrawerDirty("sheet");
        return;
      }
      if (!e.target.closest(".ss-test")) return;
      const out = card.querySelector(".ss-status");
      const src = collectSheetSources()[Number(card.dataset.idx)];
      const ofSaved = !drawerDirty("sheet");
      out.classList.remove("hidden");
      out.dataset.state = "";
      out.textContent = "Reading the sheet...";
      try {
        const r = await api("POST", "/api/sheet/test", {
          sheet_url: src.url,
          sheet_key_column: src.key_column || sheetKeyLabel(src.key_field),
          sheet_map: src.map,
        });
        const mapped = r.mapped.map((m) => `${m.column} → ${m.field}`).join(", ") || "none";
        const secs = (r.sections || []).map((x) => `${x.name} (${x.rows})`).join(", ");
        out.textContent = `Connected: ${r.rows} rows${secs ? " in " + secs : ""}, key column "${r.key_column}". ` +
          `Mapped: ${mapped}.` + (r.unmapped.length ? ` Not used: ${r.unmapped.join(", ")}.` : "");
        out.dataset.state = "running";
        if (ofSaved) { sheetHealth = { rows: r.rows }; renderIntegrations(); }
      } catch (err) {
        out.dataset.state = "error";
        out.textContent = err.message;
        if (ofSaved) { sheetHealth = { error: err.message }; renderIntegrations(); }
      }
    });
  }
  on("sheet-check", "click", (e) => {
    if (!e.target.closest("[data-sheet-fix]") || !sheetRow) return;
    const values = {};
    sheetMismatches().forEach((m) => { values[m.field] = m.want; });
    const filled = applySheetValues(values, true);
    showToast(filled.length ? `Set from the sheet: ${filled.join(", ")}` : "Nothing to change", "indigo");
  });
}

/* ---- sheet cross-check ------------------------------------------------------ */
// With a sheet row found for the Imaging Package, the system-environment values
// typed in the note are compared with that row; any that disagree get a red
// outline and a line under the package fields. Empty fields are not a mismatch
// (the lookup fills them); Serial Number is per unit, so it is never compared.
let sheetRow = null;   // { key, section, values } for the package in the note

// A saved note was opened: its package is compared afresh.
export function clearSheetRow() { sheetRow = null; }
const SHEET_CHECK_FIELDS = ["os_version", "device_type", "device_firmware",
  "device_tool_version", "didapi", "romexis", "reco_os", "reco_pc", "reco_firmware"];
let sheetDiffSig = "";

function sheetCheckOn() { return !(settingsCache && settingsCache.sheet_check === false); }

function sheetTokens(text) {
  return String(text).toLowerCase().replace(/\bv(?=\d)/g, "").split(/[^a-z0-9.]+/).filter(Boolean);
}

// A sheet cell may offer several values ("Windows 10/11"); any one fits. "11"
// fits "Windows 11", but "1.2" does not fit "11.2".
function sheetValueMatches(have, want) {
  const a = sheetTokens(have);
  return String(want).split(/[;|,\/]/).some((alt) => {
    const b = sheetTokens(alt);
    if (!b.length) return true;
    return a.every((t) => b.includes(t)) || b.every((t) => a.includes(t));
  });
}

function sheetMismatches() {
  if (!sheetRow || !featureOn("sheet") || !sheetCheckOn()) return [];
  const out = [];
  SHEET_CHECK_FIELDS.forEach((field) => {
    const want = (sheetRow.values || {})[field];
    const id = FIELD_MAP[field];
    const have = getVal(id);
    if (want && have && !sheetValueMatches(have, want)) out.push({ field, id, want, have });
  });
  return out;
}

export function applySheetCheck() {
  document.querySelectorAll(".sheet-diff").forEach((el) => {
    el.classList.remove("sheet-diff");
    el.removeAttribute("title");
  });
  const note = $("sheet-check");
  if (!note) return;
  const bad = sheetMismatches();
  note.textContent = "";
  note.classList.toggle("hidden", !bad.length);
  if (!bad.length) { sheetDiffSig = ""; return; }
  bad.forEach((m) => {
    const el = $(m.id);
    el.classList.add("sheet-diff");
    el.title = `The sheet says: ${m.want}`;
  });
  const label = (m) => `${$(m.id).placeholder || m.id} (sheet: ${m.want})`;
  note.append(`${bad.length === 1 ? "1 value differs" : bad.length + " values differ"} from the sheet row ` +
    `for ${sheetRow.key} (${sheetRow.section}): ${bad.map(label).join(", ")}. `);
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "btn small"; btn.dataset.sheetFix = "1";
  btn.textContent = "Use sheet values";
  note.append(btn);
  // A newly found mismatch must be seen: open the environment section if shut.
  const sig = bad.map((m) => m.field + "=" + m.have).join("|");
  if (sig !== sheetDiffSig && $("env-section") && $("env-section").classList.contains("collapsed")) {
    setEnvCollapsed(false, false);
  }
  sheetDiffSig = sig;
}
