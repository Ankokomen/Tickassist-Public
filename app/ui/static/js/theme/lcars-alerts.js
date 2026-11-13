/* -- Yellow / red alert ---------------------------------------------------- */

import { $, escapeHtml, escapeRe, FORM_FIELDS_SELECTOR, getVal, on, selectValues } from "../core/dom.js";
import { KEYS, store } from "../core/storage.js";
import { showToast } from "../core/ui.js";
import { callType, FIRST_IMPRESSIONS, TROUBLESHOOTING } from "../generator/calltype.js";
import { fiTimerStart } from "../generator/fi-timer.js";
import { dropCallCard, isLcars } from "./lcars-callcard.js";

// Conditions are rules: [yellow|red] when [field] [reaches|is|contains] [value].
// The first match at the highest level wins. Kept in this browser
// (localStorage) like the theme choice, and edited in Settings on LCARS.
const ALERT_PREVIEW_MS = 6000;

const ALERT_FIELDS = {
  handle:      { label: "Handle time (First Impressions)", op: "gte", unit: "min",
                 get: () => (callType === FIRST_IMPRESSIONS && fiTimerStart
                   ? (Date.now() - fiTimerStart) / 60000 : 0) },
  contactType: { label: "Contact Type", op: "is", list: () => selectValues("contactType"), get: () => getVal("contactType") },
  callType:    { label: "Call Type", op: "is", list: () => [FIRST_IMPRESSIONS, TROUBLESHOOTING], get: () => callType },
  resStatus:   { label: "Resolution Status", op: "is", list: () => selectValues("resStatus"), get: () => getVal("resStatus") },
  deviceType:  { label: "Device Type", op: "has", get: () => getVal("deviceType") },
  dealer:      { label: "Dealer", op: "has", get: () => getVal("dealerName") },
  error:       { label: "Error / Log Info", op: "has", get: () => getVal("errorInfo") },
  problem:     { label: "Problem / Request", op: "has", get: () => getVal("problem") },
  workflow:    { label: "Troubleshooting", op: "has", get: () => getVal("workflow") },
  anyText:     { label: "Any note field", op: "has",
                 get: () => ["errorInfo", "partRec", "problem", "workflow", "nextSteps", "outcome"]
                   .map(getVal).join("\n") },
};
const ALERT_OP_LABEL = { gte: "reaches", is: "is", has: "contains" };

const ALERT_DEFAULTS = [
  { level: "yellow", field: "handle", value: "10" },
  { level: "red", field: "handle", value: "15" },
  { level: "red", field: "anyText", value: "smoke, fire, burning, burnt, sparks, sparking, shock, injur*" },
];

function loadAlertRules() {
  const raw = store.getJSON(KEYS.alerts, null);
  if (Array.isArray(raw)) {
    return raw.filter((r) => r && ALERT_FIELDS[r.field] && (r.level === "yellow" || r.level === "red"))
              .map((r) => ({ level: r.level, field: r.field, value: String(r.value ?? "") }));
  }
  return ALERT_DEFAULTS.map((r) => ({ ...r }));
}
function saveAlertRules(rules) {
  store.setJSON(KEYS.alerts, rules);
}

// Whole words, case-insensitive; a trailing * means "starts with" (injur* ->
// injured). Whole-word matching keeps "fire" from firing on "firewall".
function hasTerm(text, term) {
  const t = term.trim();
  if (!t) return false;
  const prefix = t.endsWith("*");
  const body = escapeRe(prefix ? t.slice(0, -1) : t);
  if (!body) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${body}${prefix ? "" : "(?![\\p{L}\\p{N}])"}`, "iu").test(text);
}

function ruleMatch(r) {
  const f = ALERT_FIELDS[r.field];
  const terms = String(r.value || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!f || !terms.length) return false;
  const v = f.get();
  if (f.op === "gte") { const n = parseFloat(terms[0]); return Number.isFinite(n) && v >= n; }
  if (f.op === "is") return terms.some((t) => String(v).toLowerCase() === t.toLowerCase());
  return terms.some((t) => hasTerm(String(v), t));
}

function ruleWhy(r) {
  const f = ALERT_FIELDS[r.field];
  if (f.op === "gte") return `${f.label.replace(" (First Impressions)", "")} ${r.value} ${f.unit}`;
  if (f.op === "is") return `${f.label}: ${f.get()}`;
  const hit = String(r.value).split(",").map((s) => s.trim()).find((t) => hasTerm(String(f.get()), t));
  return `${f.label} mentions "${(hit || "").replace(/\*$/, "")}"`;
}

let alertShown = "";        // level currently on screen ("" = none)
let alertAck = "";          // highest level the user acknowledged
let alertPreviewUntil = 0;  // a Settings preview is running until then
function alertRank(l) { return l === "red" ? 2 : l === "yellow" ? 1 : 0; }

function ensureAlertEls() {
  let banner = $("alert-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "alert-banner";
    banner.className = "alert-banner";
    banner.setAttribute("role", "alert");
    banner.innerHTML = `<b class="ab-level"></b><span class="ab-why"></span>` +
      `<button type="button" class="ab-ack" data-alert-ack>Acknowledge</button>`;
    document.body.appendChild(banner);
    banner.addEventListener("click", (e) => {
      if (!e.target.closest("[data-alert-ack]")) return;
      alertAck = alertShown;
      if (alertPreviewUntil) alertPreviewUntil = 0;
      evaluateAlerts();
    });
  }
  if (!$("alert-vignette")) {
    const v = document.createElement("div");
    v.id = "alert-vignette";
    v.className = "alert-vignette";
    v.setAttribute("aria-hidden", "true");
    document.body.appendChild(v);
  }
  return banner;
}

function setAlert(level, why) {
  const html = document.documentElement;
  if (!level) {
    alertShown = "";
    delete html.dataset.alert;
    const b = $("alert-banner");
    if (b) b.classList.remove("on");
    return;
  }
  const banner = ensureAlertEls();
  const changed = level !== alertShown;
  alertShown = level;
  html.dataset.alert = level;
  banner.dataset.level = level;
  banner.querySelector(".ab-level").textContent = level === "red" ? "RED ALERT" : "YELLOW ALERT";
  const text = (why || "").toUpperCase();
  const whyEl = banner.querySelector(".ab-why");
  if (whyEl.textContent !== text) whyEl.textContent = text;
  banner.classList.add("on");
  if (changed) { banner.classList.remove("flash"); void banner.offsetWidth; banner.classList.add("flash"); }
}

function evaluateAlerts() {
  if (!isLcars()) { alertAck = ""; return setAlert(""); }
  if (alertPreviewUntil && Date.now() < alertPreviewUntil) return;
  if (alertPreviewUntil) { alertPreviewUntil = 0; alertAck = ""; }
  let level = "", why = "";
  for (const r of loadAlertRules()) {
    if (!ruleMatch(r)) continue;
    if (alertRank(r.level) > alertRank(level)) { level = r.level; why = ruleWhy(r); }
  }
  if (!level) alertAck = "";                       // condition cleared: re-arm
  else if (alertRank(alertAck) >= alertRank(level)) return setAlert("");  // acknowledged
  setAlert(level, why);
}

function previewAlert(level) {
  alertAck = "";
  alertPreviewUntil = Date.now() + ALERT_PREVIEW_MS;
  setAlert(level, "PREVIEW - NO CONDITION MET");
  setTimeout(evaluateAlerts, ALERT_PREVIEW_MS + 50);
}

/* Settings > Alert Conditions */
function renderAlertRules() {
  const box = $("alert-rules");
  if (!box) return;
  const rules = loadAlertRules();
  const fieldOpts = (sel) => Object.entries(ALERT_FIELDS)
    .map(([k, f]) => `<option value="${k}"${k === sel ? " selected" : ""}>${escapeHtml(f.label)}</option>`).join("");
  box.innerHTML = rules.length ? rules.map((r, i) => {
    const f = ALERT_FIELDS[r.field];
    const list = f.list ? f.list() : [];
    return `<div class="alert-rule ${r.level}" data-i="${i}">
      <select class="select" data-k="level" aria-label="Alert level">
        <option value="yellow"${r.level === "yellow" ? " selected" : ""}>Yellow</option>
        <option value="red"${r.level === "red" ? " selected" : ""}>Red</option></select>
      <span class="ar-when">when</span>
      <select class="select" data-k="field" aria-label="Field">${fieldOpts(r.field)}</select>
      <span class="ar-op">${ALERT_OP_LABEL[f.op]}</span>
      <input class="input" data-k="value" value="${escapeHtml(r.value)}" aria-label="Value"
        ${list.length ? `list="alert-list-${i}"` : ""} placeholder="${f.op === "gte" ? "minutes" : f.op === "is" ? "value, value" : "word, prefix*"}">
      ${list.length ? `<datalist id="alert-list-${i}">${list.map((v) => `<option value="${escapeHtml(v)}">`).join("")}</datalist>` : ""}
      ${f.unit ? `<span class="ar-unit">${f.unit}</span>` : ""}
      <button type="button" class="icon-btn" data-ar-del aria-label="Remove condition" title="Remove">&times;</button>
    </div>`;
  }).join("") : `<div class="settings-hint">No conditions - no alerts will fire. Add one, or reset to the defaults.</div>`;
}

export function initAlerts() {
  const box = $("alert-rules");
  if (box) {
    const read = () => [...box.querySelectorAll(".alert-rule")].map((row) => ({
      level: row.querySelector('[data-k="level"]').value,
      field: row.querySelector('[data-k="field"]').value,
      value: row.querySelector('[data-k="value"]').value,
    }));
    box.addEventListener("input", (e) => {
      if (e.target.matches('[data-k="value"]')) { saveAlertRules(read()); evaluateAlerts(); }
    });
    box.addEventListener("change", (e) => {
      if (e.target.matches('[data-k="field"]')) {
        const row = e.target.closest(".alert-rule");
        const rules = read(); const i = Number(row.dataset.i);
        rules[i].value = "";       // a value for one field means nothing for another
        saveAlertRules(rules); renderAlertRules(); evaluateAlerts();
      } else if (e.target.matches('[data-k="level"]')) {
        saveAlertRules(read()); renderAlertRules(); evaluateAlerts();
      }
    });
    box.addEventListener("click", (e) => {
      const del = e.target.closest("[data-ar-del]");
      if (!del) return;
      const rules = read(); rules.splice(Number(del.closest(".alert-rule").dataset.i), 1);
      saveAlertRules(rules); renderAlertRules(); evaluateAlerts();
    });
  }
  on("btn-alert-add", "click", () => {
    const rules = loadAlertRules();
    rules.push({ level: "yellow", field: "anyText", value: "" });
    saveAlertRules(rules); renderAlertRules();
  });
  on("btn-alert-reset", "click", () => {
    saveAlertRules(ALERT_DEFAULTS.map((r) => ({ ...r })));
    renderAlertRules(); evaluateAlerts();
    showToast("Alert conditions reset to the defaults", "indigo");
  });
  on("btn-alert-test-y", "click", () => previewAlert("yellow"));
  on("btn-alert-test-r", "click", () => previewAlert("red"));
  renderAlertRules();
  setInterval(evaluateAlerts, 1000);
  document.querySelectorAll(FORM_FIELDS_SELECTOR)
    .forEach((el) => { el.addEventListener("input", evaluateAlerts); el.addEventListener("change", evaluateAlerts); });
  evaluateAlerts();
}

// Called when the theme changes: tear down whatever the old theme left up.
export function lcarsThemeChanged() {
  if (!isLcars()) dropCallCard();
  alertAck = "";
  evaluateAlerts();
  renderAlertRules();
}
