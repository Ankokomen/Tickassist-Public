/* ---- generator: collapsible System Environment --------------------------- */

import { $, getVal, on, toggle } from "../core/dom.js";
import { KEYS, store } from "../core/storage.js";

// The block is tall and often untouched for a whole shift, so it folds away to
// keep the form on one screen. Collapsing only hides it - every field keeps its
// value, still saves, and still restores - so the header carries a summary of
// what is filled in, and the section springs open if an import fills it.
// Order matters: this is what the collapsed summary reads out.
const ENV_SUMMARY_FIELDS = [
  "deviceType", "serialNumber", "osVersion", "deviceFirmware",
  "deviceToolVersion", "didapi", "romexis", "imagingPackage", "recoOs", "recoPc",
  "recoFirmware",
];
const ENV_SUMMARY_MAX = 3;

export function setEnvCollapsed(collapsed, persist = true) {
  const section = $("env-section");
  const toggle = $("env-toggle");
  if (!section || !toggle) return;
  section.classList.toggle("collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  if (persist) store.set(KEYS.envCollapsed, collapsed ? "1" : "0");
  renderEnvSummary();
}

// "Promax 3D Mid · ABC123 · 5.2 +2 more" - enough to see the block is not empty
// without expanding it.
export function renderEnvSummary() {
  const el = $("env-summary");
  if (!el) return;
  const values = ENV_SUMMARY_FIELDS.map(getVal).filter(Boolean);
  if (!values.length) {
    el.textContent = "empty";
    return;
  }
  const shown = values.slice(0, ENV_SUMMARY_MAX).join(" · ");
  const rest = values.length - ENV_SUMMARY_MAX;
  el.textContent = rest > 0 ? `${shown} +${rest} more` : shown;
}

// Called after anything fills the form for the user (an import, or opening a
// saved ticket). Values landing inside a folded section would otherwise be easy
// to miss. The stored preference is deliberately left alone - this is a reveal
// for the note in hand, not a change of mind about the default.
export function revealEnvIfFilled() {
  const section = $("env-section");
  if (!section || !section.classList.contains("collapsed")) return;
  if (ENV_SUMMARY_FIELDS.some((id) => getVal(id))) setEnvCollapsed(false, false);
}

export function initEnvCollapsed() {
  setEnvCollapsed(store.get(KEYS.envCollapsed) === "1", false);
  on("env-toggle", "click", () =>
    setEnvCollapsed(!$("env-section").classList.contains("collapsed")));
}
