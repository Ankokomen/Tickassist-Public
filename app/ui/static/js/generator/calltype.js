/* ---- call type: the standing rotation ----------------------------------- */

import { KEYS, store } from "../core/storage.js";
import { resetFiSteps } from "./fi-steps.js";
import { renderFiTimer } from "./fi-timer.js";

// A tech works one rotation for days at a time, so this is a mode, not a
// per-note field: the topbar toggle holds it, every saved note is stamped with
// it, and it survives Clear, saves, and restarts until deliberately switched.
//
// Two values are in play. `callType` is what the note currently in the
// generator will be saved as; `standingCallType` is the rotation to fall back
// to whenever the form is cleared. They differ only while a saved ticket from
// the other rotation is open for editing - which is exactly what stops an old
// Troubleshooting note from being silently retagged on update.
export const FIRST_IMPRESSIONS = "First Impressions";
export const TROUBLESHOOTING = "Troubleshooting";
export const CALL_TYPES = [FIRST_IMPRESSIONS, TROUBLESHOOTING];
const DEFAULT_CALL_TYPE = TROUBLESHOOTING;
// Notes written before the rename carry the singular; the server rewrites them
// on save and on startup, but a value can still arrive here from a stored
// draft or a pasted note.
const LEGACY_CALL_TYPES = { "First Impression": FIRST_IMPRESSIONS };
export function canonicalCallType(v) { return LEGACY_CALL_TYPES[v] || v; }

export let callType = DEFAULT_CALL_TYPE;
export let standingCallType = DEFAULT_CALL_TYPE;

function renderCallType() {
  document.querySelectorAll("[data-call-type-group] .mode-opt").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.callType === callType)));
  // Tints the topbar on the First Impressions rotation (see styles.css).
  document.body.dataset.rotation =
    callType === FIRST_IMPRESSIONS ? "first-impression" : "troubleshooting";
  // The handle timer only shows on First Impressions; its visibility follows
  // every path that moves the rotation (toggle, edit, restore, import).
  renderFiTimer();
}

// setStanding=false while editing a saved ticket: retag just that note without
// moving the rotation the next blank form will start from.
export function setCallType(value, setStanding = true) {
  value = canonicalCallType(value);
  const before = callType;
  callType = CALL_TYPES.includes(value) ? value : DEFAULT_CALL_TYPE;
  if (callType !== before) resetFiSteps();   // each rotation starts fresh
  if (setStanding) {
    standingCallType = callType;
    store.set(KEYS.callType, callType);
  }
  renderCallType();
}

export function initCallType() {
  const stored = canonicalCallType(store.get(KEYS.callType));
  standingCallType = CALL_TYPES.includes(stored) ? stored : DEFAULT_CALL_TYPE;
  callType = standingCallType;
  renderCallType();
}
