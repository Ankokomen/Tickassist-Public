/* ---- required fields ------------------------------------------------------- */

import { api } from "../core/api.js";
import { $, escapeHtml, getVal, on, selectValues } from "../core/dom.js";
import { showToast } from "../core/ui.js";
import { callType, FIRST_IMPRESSIONS, TROUBLESHOOTING } from "./calltype.js";
import { revealFields } from "./fi-steps.js";
import { update } from "./preview.js";
import { loadSettings, settingsCache } from "../pages/settings.js";

// Rules (Settings > Lists & Macros) name fields that must be filled before Save,
// depending on the Device Type or Contact Type. Shift+Click on Save skips them,
// as it does the Case ID check. Rules and the software-device list are server
// settings, so an office install shares them.
const REQ_FIELDS = [
  ["serialNumber", "Serial Number"], ["osVersion", "OS Version"],
  ["deviceFirmware", "Device Firmware"], ["deviceToolVersion", "Device Tool Ver"],
  ["deviceType", "Device Type"], ["recoPc", "Reco Unit"], ["contact", "Contact Name"],
  ["phone", "Phone Number"], ["dealerName", "Dealer Company"], ["problem", "Problem / Request"],
];
export const REQ_LABEL = Object.fromEntries(REQ_FIELDS);
const REQ_KIND_LABEL = {
  always: "any device (always)", hardware: "Device Type is hardware (not software)", software: "Device Type is software",
  device: "Device Type contains", contact: "Contact Type is",
};
const REQ_DEFAULT_RULES = [
  { during: "First Impressions", kind: "always", value: "", fields: ["contact", "phone", "deviceType"] },
  { during: "First Impressions", kind: "hardware", value: "", fields: ["serialNumber"] },
  { during: "Troubleshooting", kind: "hardware", value: "", fields: ["serialNumber", "osVersion", "deviceFirmware"] },
];
const REQ_DEFAULT_SOFTWARE = "Workstation, Server, Romexis";
let reqRulesDraft = null;   // being edited in Settings, not yet saved

function reqRules() {
  const raw = settingsCache && settingsCache.required_rules;
  if (raw == null) return REQ_DEFAULT_RULES;
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch (e) { return REQ_DEFAULT_RULES; }
}

function reqSoftwareList(text) {
  const raw = text != null ? text
    : (settingsCache && settingsCache.software_devices != null ? settingsCache.software_devices : REQ_DEFAULT_SOFTWARE);
  return String(raw).split(/[,;\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// "" no device entered, else "software" or "hardware".
function deviceKind(name) {
  const n = (name || "").trim().toLowerCase();
  if (!n) return "";
  return (n.includes("software") || reqSoftwareList().includes(n)) ? "software" : "hardware";
}

function reqRuleApplies(rule) {
  if (rule.during && rule.during !== callType) return false;
  if (rule.kind === "always") return true;
  const device = getVal("deviceType");
  if (rule.kind === "hardware" || rule.kind === "software") return deviceKind(device) === rule.kind;
  if (rule.kind === "device") return !!rule.value && device.toLowerCase().includes(String(rule.value).toLowerCase());
  if (rule.kind === "contact") return !!rule.value && getVal("contactType") === rule.value;
  return false;
}

export function requiredFieldIds() {
  const ids = new Set();
  reqRules().forEach((r) => { if (reqRuleApplies(r)) (r.fields || []).forEach((f) => ids.add(f)); });
  return ids;
}

export function missingRequired() {
  return [...requiredFieldIds()].filter((id) => $(id) && !getVal(id).trim());
}

// Amber mark on the fields still needed; follows the note as it changes.
export function applyRequiredMarks() {
  const needed = requiredFieldIds();
  REQ_FIELDS.forEach(([id]) => {
    const el = $(id);
    if (!el) return;
    const need = needed.has(id) && !getVal(id).trim();
    el.classList.toggle("req-needed", need);
    if (!need) el.classList.remove("req-missing");
    if (needed.has(id)) el.setAttribute("aria-required", "true"); else el.removeAttribute("aria-required");
  });
}

export function reportMissingRequired(missing) {
  revealFields(missing);
  missing.forEach((id) => $(id).classList.add("req-missing"));
  showToast("Required: " + missing.map((id) => REQ_LABEL[id] || id).join(", "), "red");
  const first = $(missing[0]);
  if (first) { first.focus(); first.scrollIntoView({ block: "center", behavior: "smooth" }); }
}

// ---- the Settings panel
function readReqRules() {
  return [...document.querySelectorAll("#req-rules [data-req-row]")].map((row) => {
    const v = row.querySelector("[data-req-value]");
    return {
      during: row.querySelector("[data-req-during]").value,
      kind: row.querySelector("[data-req-kind]").value,
      value: v ? v.value.trim() : "",
      fields: [...row.querySelectorAll("[data-req-field]:checked")].map((c) => c.dataset.reqField),
    };
  });
}

function renderReqPanel() {
  const box = $("req-rules");
  if (!box) return;
  const rules = reqRulesDraft || reqRules();
  const contactTypes = selectValues("contactType");
  box.innerHTML = rules.length ? rules.map((r, i) => {
    const durings = [["", "any call type"], [FIRST_IMPRESSIONS, FIRST_IMPRESSIONS], [TROUBLESHOOTING, TROUBLESHOOTING]]
      .map(([v, l]) => `<option value="${v}"${(r.during || "") === v ? " selected" : ""}>${escapeHtml(l)}</option>`).join("");
    const kinds = Object.entries(REQ_KIND_LABEL).map(([k, label]) =>
      `<option value="${k}"${r.kind === k ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
    let value = "";
    if (r.kind === "device") {
      value = `<input class="input" type="text" data-req-value value="${escapeHtml(r.value || "")}" placeholder="e.g. Promax" autocomplete="off">`;
    } else if (r.kind === "contact") {
      value = `<select class="select" data-req-value>` + contactTypes.map((t) =>
        `<option${r.value === t ? " selected" : ""}>${escapeHtml(t)}</option>`).join("") + `</select>`;
    }
    const checks = REQ_FIELDS.map(([id, label]) =>
      `<label class="req-check"><input type="checkbox" data-req-field="${id}"${(r.fields || []).includes(id) ? " checked" : ""}> ${escapeHtml(label)}</label>`).join("");
    return `<div class="req-rule" data-req-row="${i}">` +
      `<div class="req-rule-when"><span>During</span><select class="select" data-req-during>${durings}</select><span>when</span><select class="select" data-req-kind>${kinds}</select>${value}` +
      `<button type="button" class="btn small red" data-req-del title="Remove this rule">Remove</button></div>` +
      `<div class="req-rule-fields"><span>require</span>${checks}</div></div>`;
  }).join("") : '<p class="field-help">No rules: nothing is required.</p>';
}

async function saveReqRules() {
  try {
    await api("POST", "/api/settings", {
      required_rules: JSON.stringify(readReqRules()),
      software_devices: getVal("req-software"),
    });
    reqRulesDraft = null;
    reqEdited = false;
    await loadSettings();
    update();
    showToast("Required fields saved", "green");
  } catch (err) { showToast(err.message, "red"); }
}

export function initRequired() {
  const box = $("req-rules");
  if (!box) return;
  // Anything touched in the panel is yours until it is saved: settings being
  // read again (any drawer opening does that) must not take it back.
  const edited = () => { reqEdited = true; };
  box.addEventListener("input", edited);
  box.addEventListener("change", edited);
  box.addEventListener("click", (e) => { if (e.target.closest("[data-req-del]")) edited(); });
  ["btn-req-add", "btn-req-reset"].forEach((id) => on(id, "click", edited));
  on("req-software", "input", edited);
  on("btn-req-add", "click", () => {
    reqRulesDraft = readReqRules();
    reqRulesDraft.push({ during: "", kind: "hardware", value: "", fields: [] });
    renderReqPanel();
  });
  on("btn-req-reset", "click", () => {
    reqRulesDraft = JSON.parse(JSON.stringify(REQ_DEFAULT_RULES));
    $("req-software").value = REQ_DEFAULT_SOFTWARE;
    renderReqPanel();
  });
  on("btn-req-save", "click", saveReqRules);
  box.addEventListener("change", (e) => {
    if (e.target.matches("[data-req-during]")) { reqRulesDraft = readReqRules(); renderReqPanel(); return; }
    if (e.target.matches("[data-req-kind]")) {   // the value control changes with the condition
      reqRulesDraft = readReqRules();
      reqRulesDraft.forEach((r, i) => { if (i === +e.target.closest("[data-req-row]").dataset.reqRow) r.value = ""; });
      renderReqPanel();
    }
  });
  box.addEventListener("click", (e) => {
    const del = e.target.closest("[data-req-del]");
    if (!del) return;
    reqRulesDraft = readReqRules();
    reqRulesDraft.splice(+del.closest("[data-req-row]").dataset.reqRow, 1);
    renderReqPanel();
  });
  // A field that was blocked loses its red outline as soon as it is touched.
  document.addEventListener("input", (e) => {
    if (e.target.classList && e.target.classList.contains("req-missing")) e.target.classList.remove("req-missing");
  });
}

// Settings were (re)loaded: show the saved rules - unless the panel holds
// edits that have not been saved yet.
let reqEdited = false;
export function resetReqPanel() {
  if (reqEdited) return;
  reqRulesDraft = null;
  if ($("req-software")) {
    $("req-software").value = settingsCache && settingsCache.software_devices != null
      ? settingsCache.software_devices : REQ_DEFAULT_SOFTWARE;
  }
  renderReqPanel();
}
