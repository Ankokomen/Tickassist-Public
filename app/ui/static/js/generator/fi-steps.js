/* ---- First Impressions: step by step ------------------------------------------ */

import { $, getVal, on } from "../core/dom.js";
import { clip } from "../core/format.js";
import { showToast } from "../core/ui.js";
import { callType, FIRST_IMPRESSIONS } from "./calltype.js";
import { editing } from "./edit-session.js";
import { setEnvCollapsed } from "./env-section.js";
import { getOsLabel } from "./fields.js";
import { missingRequired, REQ_LABEL, requiredFieldIds } from "./required.js";

// On First Impressions the form works one section at a time. A section whose
// required fields (Settings > Required Fields) are filled folds into a summary
// line when you leave it, and the next one opens; a section stays locked until
// the ones above it are filled in. Nothing is cleared. "Open all sections", or
// Shift+click on a locked section, lifts the order; Troubleshooting and editing
// a saved ticket never use it.
const FI_STEPS = [
  { key: "caller", title: "Caller", summary: () => [getVal("contact"), getVal("phone"), getVal("contactType") === "Dealer" ? getVal("dealerName") : ""].filter(Boolean).join(" \u00b7 ") },
  { key: "env", title: "System Environment", summary: () => [getVal("deviceType"), getVal("serialNumber"), [getOsLabel(), getVal("osVersion")].filter(Boolean).join(" ")].filter(Boolean).join(" \u00b7 ") },
  { key: "diag", title: "Diagnostics", summary: () => [getVal("errorInfo"), getVal("partRec")].filter(Boolean).join(" \u00b7 ") },
  { key: "details", title: "Case Details", summary: () => getVal("problem") || getVal("workflow") },
  { key: "resolution", title: "Resolution", summary: () => getVal("resStatus") },
];
let fiKeyAt = 0;     // when Tab was last pressed
let fiFolded = {};   // step key -> folded by leaving it (or by its header)

function fiStepEl(key) { return document.querySelector(`[data-fi-step="${key}"]`); }
function fiStepIds(key) {
  return [...fiStepEl(key).querySelectorAll("input[id], textarea[id], select[id]")].map((e) => e.id);
}
function fiActive() {
  return callType === FIRST_IMPRESSIONS && !editing && document.body.dataset.fiMore !== "1";
}
function fiStepMissing(key) {
  const ids = new Set(fiStepIds(key));
  return missingRequired().filter((id) => ids.has(id));
}

export function renderFiSteps() {
  const btn = $("fi-more");
  if (btn) {
    const all = document.body.dataset.fiMore === "1";
    btn.textContent = all ? "Back to step by step" : "Open all sections";
    btn.setAttribute("aria-pressed", String(all));
  }
  const active = fiActive();
  let unlocked = true;
  FI_STEPS.forEach((s, i) => {
    const el = fiStepEl(s.key);
    if (!el) return;
    const head = el.querySelector(".fi-step-head");
    const status = head.querySelector(".fi-step-status");
    if (!active) { el.dataset.state = "open"; status.textContent = ""; return; }
    const missing = fiStepMissing(s.key);
    let state = !unlocked ? "locked" : (fiFolded[s.key] && !missing.length ? "folded" : "open");
    el.dataset.state = state;
    head.setAttribute("aria-expanded", String(state === "open"));
    status.classList.toggle("need", state === "open" && missing.length > 0);
    if (state === "locked") status.textContent = "Locked";
    else if (state === "folded") status.textContent = clip(s.summary()) || "Done";
    else status.textContent = missing.length ? "Needs: " + missing.map((id) => REQ_LABEL[id] || id).join(", ") : "";
    if (missing.length) unlocked = false;
  });
}

// A new rotation or a cleared form starts step by step from the top.
export function resetFiSteps() {
  document.body.dataset.fiMore = "";
  fiFolded = {};
}

// Fields that must be seen now (a blocked Save): open the environment section
// and unfold the First Impressions steps that hold them.
export function revealFields(ids) {
  if ($("env-section") && $("env-section").classList.contains("collapsed")) setEnvCollapsed(false, false);
  ids.forEach((id) => { const s = $(id).closest("[data-fi-step]"); if (s) fiFolded[s.dataset.fiStep] = false; });
  renderFiSteps();
}

export function initFiMore() {
  on("fi-more", "click", () => {
    document.body.dataset.fiMore = document.body.dataset.fiMore === "1" ? "" : "1";
    renderFiSteps();
  });
  document.querySelectorAll("[data-fi-head]").forEach((head) => head.addEventListener("click", (e) => {
    if (!fiActive()) return;
    const key = head.dataset.fiHead;
    const state = fiStepEl(key).dataset.state;
    if (state === "locked") {
      if (e.shiftKey) { document.body.dataset.fiMore = "1"; renderFiSteps(); return; }
      const i = FI_STEPS.findIndex((s) => s.key === key);
      const blocker = FI_STEPS.slice(0, i).find((s) => fiStepMissing(s.key).length);
      showToast(blocker ? `Fill in ${fiStepMissing(blocker.key).map((id) => REQ_LABEL[id] || id).join(", ")} first` : "Fill in the sections above first", "amber");
      return;
    }
    fiFolded[key] = state === "open";
    renderFiSteps();
    if (!fiFolded[key]) { const f = fiStepEl(key).querySelector("input:not([readonly]):not([type=checkbox]), textarea"); if (f) f.focus(); }
  }));
  // Leaving a finished section with Tab folds it and moves on to the next.
  document.addEventListener("keydown", (e) => { if (e.key === "Tab" && !e.shiftKey) fiKeyAt = Date.now(); }, true);
  document.addEventListener("focusout", (e) => {
    if (!fiActive()) return;
    const body = e.target.closest && e.target.closest(".fi-step-body");
    if (!body) return;
    const stepEl = body.parentElement, key = stepEl.dataset.fiStep;
    const to = e.relatedTarget;
    if (to && body.contains(to)) return;
    // Only fold when the user moved on with the keyboard (Tab/Enter). Folding
    // on a mouse click shifted the layout under the pointer and swallowed the click.
    if (Date.now() - fiKeyAt > 400) return;
    const hasRules = missingRequired().length || [...requiredFieldIds()].some((id) => fiStepIds(key).includes(id));
    if (!hasRules || fiStepMissing(key).length || fiFolded[key]) return;
    fiFolded[key] = true;
    renderFiSteps();
    const nextEl = [...document.querySelectorAll("[data-fi-step]")].find((el) => el.dataset.state === "open" && el !== stepEl && FI_STEPS.findIndex((s) => s.key === el.dataset.fiStep) > FI_STEPS.findIndex((s) => s.key === key));
    if (nextEl && (!to || to.closest("[data-fi-step]") === nextEl || !to.closest("[data-fi-step]"))) {
      setTimeout(() => {
        const need = missingRequired().find((id) => nextEl.contains($(id)));
        const f = need ? $(need) : nextEl.querySelector("input:not([readonly]):not([type=checkbox]), textarea");
        if (f) f.focus();
      }, 0);
    }
  });
}
