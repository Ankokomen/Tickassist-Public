/* DOM shorthands shared by every module. */

export function $(id) { return document.getElementById(id); }

// Null-safe event wiring: a missing/removed element never aborts start-up.
export function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
}

export function toggle(id, hidden) { $(id).classList.toggle("hidden", hidden); }

export function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function getVal(id) { const el = $(id); return el ? el.value.trim() : ""; }

export function hasVal(v) { return v && v.trim() !== ""; }

export function selectValues(id) {
  const el = $(id);
  return el ? [...el.options].map((o) => o.value).filter(Boolean) : [];
}

// Every field of the Note Generator form.
export const FORM_FIELDS_SELECTOR = ".form-panel input, .form-panel textarea, .form-panel select";

// Fire the event a user's edit would, so every listener on the field follows.
export function fireInput(el, type = "input") {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

export function isShown(id) {
  const el = $(id);
  return !!el && !el.classList.contains("hidden");
}
