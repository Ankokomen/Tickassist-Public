/* ---- generator: AI polish ----------------------------------------------- */

import { api } from "../core/api.js";
import { $, getVal } from "../core/dom.js";
import { showToast } from "../core/ui.js";
import { featureOn } from "../features.js";
import { normalizeResolutionStatus } from "./fields.js";
import { autoGenerateTitle, update } from "./preview.js";

// LCARS only: a scan overlay pinned to the visible part of the note preview
// (so it shows on a long note and wherever the panel is scrolled). Other
// themes, and anyone who asked for reduced motion, never create it.
let aiScanEl = null;
let aiScanTimer = null;
function startAiScan() {
  stopAiScan(false);
  if (document.documentElement.dataset.theme !== "lcars") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const body = $("print-area");
  const panel = body && body.closest(".panel");
  if (!panel) return;
  const pr = panel.getBoundingClientRect();
  const head = panel.querySelector(".preview-head");
  const bar = document.querySelector(".topbar");
  const top = Math.max(head ? head.getBoundingClientRect().bottom : pr.top,
                       bar ? bar.getBoundingClientRect().bottom : 0);
  const bottom = Math.min(pr.bottom, window.innerHeight);
  const left = pr.left + panel.clientLeft;
  const width = Math.min(pr.right, window.innerWidth) - left;
  if (bottom - top < 40 || width < 40) return;
  const el = document.createElement("div");
  el.className = "ai-scan";
  el.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${bottom - top}px;--h:${bottom - top}px`;
  el.innerHTML = '<i class="ai-scan-band"></i>';
  document.body.appendChild(el);
  aiScanEl = el;
}
function stopAiScan(finished) {
  clearTimeout(aiScanTimer);
  const el = aiScanEl;
  aiScanEl = null;
  if (!el) return;
  if (finished) {            // one fast closing pass, then remove
    el.classList.add("done");
    aiScanTimer = setTimeout(() => el.remove(), 900);
  } else {
    el.remove();
  }
}

// What the fields held before the last AI Polish, until undone or the form
// is cleared. The model can rewrite more than the technician wanted.
let polishUndo = null;
function renderPolishUndo(show) {
  const b = $("btn-polish-undo");
  if (b) b.classList.toggle("hidden", !(show && polishUndo));
}
export function undoPolish() {
  if (!polishUndo) return;
  $("problem").value = polishUndo.problem; $("workflow").value = polishUndo.workflow;
  $("nextSteps").value = polishUndo.nextSteps; $("contact").value = polishUndo.contact;
  $("outcome").value = polishUndo.outcome;
  polishUndo = null; renderPolishUndo(false);
  autoGenerateTitle(); update();
  showToast("AI Polish undone - your text is back", "slate");
}

export async function aiPolish() {
  if (!featureOn("polish")) return;
  const problem = getVal("problem");
  const workflow = getVal("workflow");
  const nextSteps = getVal("nextSteps");
  if (!problem && !workflow && !nextSteps) {
    showToast("Enter Problem, Troubleshooting, or Next Steps to polish", "red");
    return;
  }
  const btn = $("btn-polish");
  const original = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Working...';
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  document.body.classList.add("ai-busy");   // themes may animate "thinking"
  startAiScan();
  let polished = false;
  try {
    const payload = {
      problem, workflow,
      next_steps: nextSteps,
      status: normalizeResolutionStatus($("resStatus").value),
      outcome: getVal("outcome"),
      errors: getVal("errorInfo"),
      device: getVal("deviceType"),
      serial: getVal("serialNumber"),
      contact: getVal("contact"),
    };
    const data = await api("POST", "/api/polish", payload);
    const r = data.result || {};
    // Keep what was there, so one click puts it back.
    polishUndo = { problem, workflow, nextSteps, contact: getVal("contact"), outcome: getVal("outcome") };
    const skip = new Set((r.warnings || []).map((w) => w.field));   // the server kept the original
    if (r.problem && !skip.has("problem")) $("problem").value = r.problem;
    if (r.contact) $("contact").value = r.contact;
    if (r.workflow && !skip.has("workflow")) $("workflow").value = r.workflow;
    if (r.next_steps && !skip.has("next_steps")) $("nextSteps").value = r.next_steps;
    if (r.resolution) $("outcome").value = r.resolution;
    // Title is auto-generated (device - problem - serial); regenerate from the
    // polished problem rather than letting the model set it.
    autoGenerateTitle();
    update();
    const kept = (r.warnings || []).map((w) => ({ workflow: "Troubleshooting", next_steps: "Next Steps", problem: "Problem" }[w.field] || w.field));
    showToast(kept.length ? `AI Polish applied - but it would have dropped detail from ${kept.join(" and ")}, so your original was kept`
                          : "AI Polish applied", kept.length ? "amber" : "green");
    renderPolishUndo(true);
    polished = true;
    document.body.classList.add("ai-done");
    setTimeout(() => document.body.classList.remove("ai-done"), 1000);
  } catch (err) {
    showToast(err.message, "red");
  } finally {
    btn.innerHTML = original;
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    document.body.classList.remove("ai-busy");
    stopAiScan(polished);
  }
}

// The form was cleared: there is nothing left to undo.
export function clearPolishUndo() {
  polishUndo = null;
  renderPolishUndo(false);
}
