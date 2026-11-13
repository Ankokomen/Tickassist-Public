/* ---- import a CURRENT SERVER INFO report ------------------------------------ */

import { api } from "../core/api.js";
import { $, escapeHtml, getVal, on } from "../core/dom.js";
import { setMessage, showToast } from "../core/ui.js";
import { renderEnvSummary, revealEnvIfFilled } from "../generator/env-section.js";
import { FIELD_MAP, getOs } from "../generator/fields.js";
import { update } from "../generator/preview.js";
import { setFieldFromSheet } from "../integrations/sheets.js";
import { setSettingsCache, settingsCache } from "./settings.js";

// What to read is set by rules (Settings > Server report import). Lines no rule
// covers are listed with a drop-down, so a one-off line can be used right away
// and, if wanted, remembered as a rule.
let reportRows = [];
let reportOs = null;
let reportExtras = [];
let reportTargets = [];

function reportShow(step) {
  $("import-step1").classList.toggle("hidden", step !== 1);
  $("import-step2").classList.toggle("hidden", step !== 2);
}
function reportMessage(text, kind) { setMessage("import-msg", text, kind); }
function openReportModal() {
  $("import-text").value = "";
  reportMessage("");
  reportShow(1);
  $("import-modal").classList.remove("hidden");
  $("import-text").focus();
}
function closeReportModal() { $("import-modal").classList.add("hidden"); }

async function readReport() {
  const text = $("import-text").value;
  if (!text.trim()) return reportMessage("Paste the report first.", "error");
  let r;
  try { r = await api("POST", "/api/serverinfo/parse", { text }); }
  catch (err) { return reportMessage(err.message, "error"); }
  if (!r.found || (!r.fields.length && !r.os_family && !(r.ignored || []).length)) {
    return reportMessage("That doesn't look like a server report - nothing to fill.", "error");
  }
  reportRows = r.fields;
  reportOs = r.os_family;
  reportExtras = r.ignored || [];
  reportTargets = r.targets || [];
  const rows = [];
  if (reportOs) rows.push({ key: "os", label: "Operating System", cur: getOs(), val: reportOs, from: "", def: true });
  reportRows.forEach((f, i) => {
    rows.push({ key: String(i), label: f.label, cur: getVal(FIELD_MAP[f.field]), val: f.value, from: f.from, def: f.default });
  });
  $("import-rows").innerHTML = rows.map((x) =>
    `<label class="check-row import-row"><input type="checkbox" data-imp="${escapeHtml(x.key)}"${x.def ? " checked" : ""}>` +
    `<span><b>${escapeHtml(x.label)}</b>: ${escapeHtml(x.val)}` +
    (x.cur && x.cur !== x.val ? ` <span class="import-was">(now: ${escapeHtml(x.cur)})</span>` : "") +
    (x.from ? `<br><span class="import-from">${escapeHtml(x.from)}</span>` : "") + `</span></label>`).join("") ||
    '<div class="field-help">Nothing in this report matches a rule.</div>';
  const opts = '<option value="">Don\'t use</option>' + reportTargets.map((tg) =>
    `<option value="${escapeHtml(tg.field)}">${escapeHtml(tg.label)}</option>`).join("");
  $("import-extra").innerHTML = reportExtras.map((x, i) =>
    `<div class="import-extra-row"><span class="import-extra-text"><b>${escapeHtml(x.label)}</b>: ${escapeHtml(x.value)}</span>` +
    `<select class="select small" data-extra="${i}" aria-label="Use ${escapeHtml(x.label)} for">${opts}</select></div>`).join("");
  $("import-extra-wrap").classList.toggle("hidden", !reportExtras.length);
  reportMessage("");
  reportShow(2);
}

function setReportField(f, value, mode) {
  const id = FIELD_MAP[f], el = $(id);
  if (!el) return false;
  if (mode === "append" && el.value.trim() && !el.value.includes(value)) value = el.value.trim() + "; " + value;
  return setFieldFromSheet(id, value, true);
}

async function applyReport() {
  const picked = new Set([...document.querySelectorAll("#import-rows [data-imp]:checked")].map((c) => c.dataset.imp));
  const done = [];
  if (picked.has("os") && reportOs) {
    document.querySelectorAll('input[name="os"]').forEach((c) => {
      const want = c.value === reportOs;
      if (c.checked !== want) { c.checked = want; c.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    done.push("Operating System");
  }
  reportRows.forEach((f, i) => {
    if (picked.has(String(i)) && setReportField(f.field, f.value, f.mode)) done.push(f.label);
  });
  // Lines picked from the "not used" list, and the rules to remember for them.
  const newRules = [];
  document.querySelectorAll("#import-extra [data-extra]").forEach((sel) => {
    if (!sel.value) return;
    const x = reportExtras[+sel.dataset.extra];
    const tg = reportTargets.find((g) => g.field === sel.value) || { kind: "text", label: sel.value };
    const value = tg.kind === "version" ? x.clean : tg.kind === "append" ? `${x.label}: ${x.value}` : x.value;
    if (setReportField(sel.value, value, tg.kind === "append" ? "append" : "set")) done.push(tg.label);
    newRules.push(`${x.label} = ${sel.value}`);
  });
  update(); revealEnvIfFilled(); renderEnvSummary();
  if (newRules.length && $("import-remember").checked) {
    const cur = String((settingsCache && settingsCache.report_rules) || "").trim();
    const merged = (cur ? cur + "\n" : "") + newRules.filter((l) => !cur.includes(l)).join("\n");
    try {
      await api("POST", "/api/settings", { report_rules: merged });
      if (settingsCache) settingsCache.report_rules = merged;
      if ($("rpt-rules")) $("rpt-rules").value = merged;
    } catch (err) { showToast(err.message, "red"); }
  }
  closeReportModal();
  showToast(done.length ? `Filled from the report: ${done.join(", ")}` : "Nothing to change - the fields already match", "indigo");
}

export function initImportReport() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("import-modal").classList.contains("hidden")) closeReportModal();
  });
  on("btn-import-report", "click", openReportModal);
  on("import-close", "click", closeReportModal);
  on("import-read", "click", readReport);
  on("import-back", "click", () => reportShow(1));
  on("import-apply", "click", applyReport);
  on("import-text", "paste", () => setTimeout(() => { if ($("import-text").value.trim()) readReport(); }, 50));
  on("import-file", "change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { $("import-text").value = String(reader.result || ""); e.target.value = ""; readReport(); };
    reader.readAsText(file);
  });
  // Settings > Server report import: the rules, one per line.
  const saveRules = async (rules, message, kind) => {
    try {
      await api("POST", "/api/settings", { report_rules: rules });
      const s = await api("GET", "/api/settings");
      setSettingsCache(s);
      $("rpt-rules").value = s.report_rules || "";
      showToast(message, kind);
    } catch (err) { showToast(err.message, "red"); }
  };
  on("btn-rpt-save", "click", () => saveRules($("rpt-rules").value, "Report rules saved", "green"));
  on("btn-rpt-reset", "click", () => saveRules("", "Report rules reset to the defaults", "indigo"));
}
