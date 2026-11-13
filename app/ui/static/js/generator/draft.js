/* ---- generator: localStorage autosave (survives unexpected reloads) ----- */

import { $, FORM_FIELDS_SELECTOR } from "../core/dom.js";
import { humanAge } from "../core/format.js";
import { KEYS, store } from "../core/storage.js";
import { showToast } from "../core/ui.js";
import { callType, setCallType } from "./calltype.js";
import { editing, setEditing } from "./edit-session.js";
import { fiTimerArmed, fiTimerStart, restoreFiTimer } from "./fi-timer.js";
import { isFormDirty, normalizeResolutionStatus } from "./fields.js";

const FORM_STORAGE_TTL_MS = 96 * 60 * 60 * 1000; // 96 hours

export function saveFormState() {
  const fields = {};
  document.querySelectorAll(FORM_FIELDS_SELECTOR).forEach((el) => {
    if (el.type === "radio") { if (el.checked) fields[el.name] = el.value; }
    else if (el.type === "checkbox") { if (el.checked) fields[el.name] = fields[el.name] ? fields[el.name] + ", " + el.value : el.value; }
    else if (el.id) fields[el.id] = el.value;
  });
  // callType rides along explicitly - the toggle lives in the topbar, outside
  // the .form-panel selector that collects everything else.
  const payload = { savedAt: Date.now(), fields, editing, callType,
                    fiTimerStart, fiTimerArmed };
  store.setJSON(KEYS.draft, payload);   // quota exceeded / private mode: not kept
}

// The live preview updates on every keystroke; batching the localStorage
// write behind a short debounce keeps typing latency at zero.
let formSaveTimer = null;
export function scheduleFormSave() {
  clearTimeout(formSaveTimer);
  formSaveTimer = setTimeout(saveFormState, 250);
}

export function restoreFormState() {
  const stored = store.getJSON(KEYS.draft, null);
  if (!stored || typeof stored !== "object") return;

  // Enforce a max recovery age; older drafts are discarded automatically.
  const hasEnvelope = Object.prototype.hasOwnProperty.call(stored, "savedAt") &&
    Object.prototype.hasOwnProperty.call(stored, "fields");
  if (!hasEnvelope || typeof stored.savedAt !== "number" || !stored.fields ||
      typeof stored.fields !== "object") {
    store.remove(KEYS.draft);
    return;
  }
  if (Date.now() - stored.savedAt > FORM_STORAGE_TTL_MS) {
    store.remove(KEYS.draft);
    return;
  }

  const data = stored.fields;
  document.querySelectorAll(FORM_FIELDS_SELECTOR).forEach((el) => {
    if (el.type === "radio") {
      if (data[el.name] !== undefined) el.checked = (el.value === data[el.name]);
    } else if (el.type === "checkbox") {
      if (data[el.name] !== undefined) el.checked = String(data[el.name]).split(/\s*,\s*/).includes(el.value);
    } else if (el.id && data[el.id] !== undefined) {
      el.value = el.id === "resStatus"
        ? normalizeResolutionStatus(data[el.id])
        : data[el.id];
    }
  });

  // A restored draft keeps the rotation it was written on; the standing one is
  // untouched, since the draft may have been an edit of the other rotation.
  if (stored.callType) setCallType(stored.callType, false);

  // Re-enter edit mode if the draft was an open saved ticket.
  if (stored.editing && stored.editing.id) setEditing(stored.editing);

  // The handle timer rides with the draft, so an accidental reload mid-call
  // can't zero the clock on a First Impressions note.
  if (typeof stored.fiTimerStart === "number" && stored.fiTimerStart <= Date.now()) {
    restoreFiTimer(stored.fiTimerStart, !!stored.fiTimerArmed);
  }

  if (isFormDirty()) {
    showToast(`Restored unsaved draft from ${humanAge(Date.now() - stored.savedAt)} ago`, "slate");
  }
}

// Set the timestamp field to the current local time (and persist it).
export function refreshTimestamp(notify) {
  const el = $("dateTime");
  if (!el) return;
  el.value = new Date().toLocaleString();
  saveFormState();
  if (notify) showToast("Timestamp updated to current time");
}
