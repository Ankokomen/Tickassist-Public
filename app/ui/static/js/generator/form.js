/* Wiring the Note Generator form: the live preview, field helpers, its
   buttons, the typable dropdowns and the rotation toggles. The order of the
   listeners matters where several watch one field (main.js keeps it). */

import { copyText } from "../core/clipboard.js";
import { $, fireInput, FORM_FIELDS_SELECTOR, getVal, on } from "../core/dom.js";
import { showToast } from "../core/ui.js";
import { featureOn } from "../features.js";
import { callType, setCallType } from "./calltype.js";
import { refreshTimestamp, scheduleFormSave } from "./draft.js";
import { editing } from "./edit-session.js";
import { fiTimerOnInput, resetFiTimer, startFiTimer } from "./fi-timer.js";
import { isFormDirty, osVersionsForChecked, osVersionsForRest, syncOs2 } from "./fields.js";
import { importNote } from "./note-import.js";
import { copyNote, normalizeBulletField } from "./note.js";
import { aiPolish, undoPolish } from "./polish.js";
import { autoGenerateTitle, formatPhone, update } from "./preview.js";
import { checkRepeatCaller, initRepeatCaller } from "./repeat-caller.js";
import { clearFields, resetFields, saveTicket } from "./save.js";
import { markContactTypePicked } from "../integrations/callwatch.js";
import { d365State, openD365Create, openNewD365Case } from "../integrations/d365.js";
import { createCombobox } from "../lists/combobox.js";
import { ENV_COMBOS, initListedFields, LISTS } from "../lists/lists.js";

export function initGeneratorForm() {
  // Live preview listeners.
  document.querySelectorAll(FORM_FIELDS_SELECTOR)
    .forEach((el) => {
      el.addEventListener("input", update);
      el.addEventListener("input", fiTimerOnInput);
    });
  document.querySelectorAll('input[name="os"]')
    .forEach((r) => r.addEventListener("change", update));
  ["deviceType", "problem", "serialNumber"].forEach((id) =>
    on(id, "input", autoGenerateTitle));

  // Reflow inline "* " bullets onto separate lines when leaving Troubleshooting
  // / Next Steps (typed or pasted text never hits the server-side polish pass).
  ["workflow", "nextSteps"].forEach((id) =>
    on(id, "blur", () => { normalizeBulletField(id); update(); }));

  on("caseNumber", "input", () => {
    const el = $("caseNumber");
    const fixed = el.value.replace(/^\s*CAS[\s-]*CAS/i, "CAS");
    if (fixed !== el.value) { el.value = fixed; update(); }
  });

  // Double-click the (read-only) timestamp to reset it to the current time.
  // That gesture marks the start of a call, so it also arms the handle timer
  // (the programmatic refresh in resetFields deliberately does not).
  on("dateTime", "dblclick", () => { startFiTimer(true); refreshTimestamp(true); });

  // Double-click the timer box to zero it, mirroring the timestamp gesture.
  // If the note already holds anything the count restarts from now; on an
  // empty note it just goes idle at 00:00 (and disarms a dbl-click start).
  on("fi-timer", "dblclick", () => {
    resetFiTimer();
    if (isFormDirty()) startFiTimer(false);
    scheduleFormSave();
    showToast("Timer reset");
  });

  on("contactType", "change", (e) => { if (e.isTrusted) markContactTypePicked(); });

  // Live phone-number formatting (###-###-####).
  on("phone", "input", () => {
    const el = $("phone");
    el.value = formatPhone(el.value);
    update();
    checkRepeatCaller();
  });
  initRepeatCaller();

  // Generator buttons (all null-safe so removing one can't break the rest).
  on("btn-polish", "click", aiPolish);
  on("btn-polish-undo", "click", undoPolish);
  on("btn-save", "click", (e) => saveTicket(false, e.shiftKey));
  on("btn-import", "click", importNote);
  on("btn-copy", "click", copyNote);
  on("btn-copy-title", "click", () => {
    const t = getVal("caseTitle");
    if (!t) { showToast("No title to copy", "red"); return; }
    copyText(t, "Title copied!");
  });
  on("btn-new-d365-case", "click", (e) =>
    (featureOn("d365") && d365State.signed_in ? openD365Create() : openNewD365Case(e.shiftKey)));
  on("btn-clear", "click", clearFields);

  // Edit-mode banner (shown while a saved ticket is open in the generator).
  on("btn-save-as-new", "click", (e) => saveTicket(true, e.shiftKey));
  // X cancels the edit session entirely: banner closes, form resets to blank.
  on("btn-stop-editing", "click", () => {
    resetFields();
    showToast("Stopped editing — form cleared", "slate");
  });

  initListCombos();
  initRotationToggles();
}

// Typeable dropdowns backed by the managed lists.
function initListCombos() {
  LISTS.dealers.combo = createCombobox("dealerName", "dealer-menu", "dealers", update);
  LISTS.device_types.combo = createCombobox("deviceType", "deviceType-menu", "device_types", autoGenerateTitle);
  LISTS.reco_units.combo = createCombobox("recoPc", "recoPc-menu", "reco_units", update);
  Object.entries(ENV_COMBOS).forEach(([key, [id]]) => {
    const onChoose = id === "imagingPackage"
      ? () => { update(); const el = $(id); fireInput(el); fireInput(el, "change"); }
      : update;
    // OS versions follow the systems ticked: Windows 10/11, Server 20xx, macOS names.
    LISTS[key].combo = createCombobox(id, id + "-menu", key, onChoose, key === "os_versions" ? osVersionsForChecked : undefined);
  });
  LISTS.os_versions.combo2 = createCombobox("osVersion2", "osVersion2-menu", "os_versions", update, osVersionsForRest);
  document.querySelectorAll('input[name="os"]').forEach((c) => c.addEventListener("change", syncOs2));
  syncOs2();
  initListedFields();
}

// Flipping either toggle while a saved ticket is open retags only that ticket;
// with no ticket open, the topbar one moves the standing rotation everything
// starts from. Both copies share this handler so they can never disagree.
function initRotationToggles() {
  const onRotationClick = (e) => {
    const opt = e.target.closest("[data-call-type]");
    if (!opt || opt.dataset.callType === callType) return;
    setCallType(opt.dataset.callType, !editing);
    update();
    showToast(editing
      ? `This ticket is now a ${opt.dataset.callType} call`
      : `Rotation set to ${opt.dataset.callType}`, "indigo");
  };
  on("call-type-toggle", "click", onRotationClick);
  on("case-call-type-toggle", "click", onRotationClick);
}
