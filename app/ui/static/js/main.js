/* TickAssist frontend - native ES modules, no build step, no dependencies.

   This file starts everything, in a fixed order: several modules listen to
   the same fields and keys, and which runs first is part of the behaviour.

     core/         DOM, API, storage, toasts, clipboard, images, formatting
     generator/    the Note Generator: form, preview, note, save, steps...
     lists/        managed dropdown lists, the combobox, shorthand macros
     integrations/ calls from MAX, D365, Google Sheets, transfer, drawers
     pages/        navigation, Settings, updates, importing a server report
     theme/        themes and the LCARS extras (call card, alerts)
*/

import { $, isShown, on } from "./core/dom.js";
import { closeModal } from "./core/ui.js";
import { initFeatures } from "./features.js";
import { initCallType } from "./generator/calltype.js";
import { restoreFormState, saveFormState } from "./generator/draft.js";
import { initEnvCollapsed } from "./generator/env-section.js";
import { initFiMore } from "./generator/fi-steps.js";
import { startFiTimerClock } from "./generator/fi-timer.js";
import { initGeneratorForm } from "./generator/form.js";
import { copyNote } from "./generator/note.js";
import { update } from "./generator/preview.js";
import { initRequired } from "./generator/required.js";
import { saveTicket } from "./generator/save.js";
import { initIncomingCalls, pollIncoming } from "./integrations/callwatch.js";
import { initD365 } from "./integrations/d365.js";
import { drawerEl, initDrawers, openDrawer, openDrawerName } from "./integrations/drawers.js";
import { initRoster } from "./integrations/roster.js";
import { initSheet } from "./integrations/sheets.js";
import { initTransfer } from "./integrations/transfer.js";
import { initListPanels, loadAllLists } from "./lists/lists.js";
import { initMacros, loadMacros } from "./lists/macros.js";
import { ensureVersionBadge, initNav, switchPage } from "./pages/nav.js";
import { initImportReport } from "./pages/report-import.js";
import { initSettingsPage, initSettingsTabs, loadSettings } from "./pages/settings.js";
import { initUpdates } from "./pages/updates.js";
import { initPhotos, loadPhotos } from "./photos.js";
import { initAlerts } from "./theme/lcars-alerts.js";
import { initCallCard } from "./theme/lcars-callcard.js";
import { initThemeControls } from "./theme/theme.js";

// No browser autofill or form history in any field: a ticket form is not a
// login or address form, and a suggestion from another field (or another
// call) landing in a note is worse than no suggestion at all.
function disableBrowserAutofill() {
  document.querySelectorAll("input, textarea").forEach((el) => {
    if (el.type === "file" || el.type === "checkbox" || el.type === "radio") return;
    el.setAttribute("autocomplete", "off");
    el.setAttribute("data-lpignore", "true");
    el.setAttribute("data-1p-ignore", "");
  });
}

// Suppress the browser's saved-info / autofill dropdowns on ticket fields
// (Edge matches labels like "Contact Name" and offers profile data).
function disableProfileAutofill() {
  document.querySelectorAll(".form-panel input").forEach((el) =>
    el.setAttribute("autocomplete", "off"));
  // Edge ignores "off" for name/phone profile autofill specifically;
  // "one-time-code" is the token browsers reliably honor as an opt-out.
  ["contact", "phone"].forEach((id) => {
    const el = $(id);
    if (el) el.setAttribute("autocomplete", "one-time-code");
  });
}

// Modal buttons and keys (Enter confirms, Escape cancels / closes), then the
// global shortcuts: Ctrl+S saves or updates, Ctrl+Enter copies the note. With
// an integration drawer open, Ctrl+S saves that drawer instead.
function initKeyboard() {
  on("modal-confirm", "click", () => closeModal(true));
  on("modal-cancel", "click", () => closeModal(false));
  on("modal", "click", (e) => { if (e.target === $("modal")) closeModal(false); });
  document.addEventListener("keydown", (e) => {
    if (!isShown("modal")) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.repeat) return;      // the key held from whatever opened the question is not an answer
      closeModal(document.activeElement !== $("modal-cancel"));
    }
    else if (e.key === "Escape") { e.preventDefault(); closeModal(false); }
  });

  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const confirmOpen = isShown("modal");
    const anyModalOpen = !!document.querySelector(".modal-backdrop:not(.hidden)") || !!openDrawerName;
    const onGenerator = $("page-generator").classList.contains("active");
    if (e.key.toLowerCase() === "s") {
      e.preventDefault(); // suppress the browser's save-page dialog everywhere
      if (openDrawerName && !confirmOpen) {
        const save = drawerEl(openDrawerName).querySelector(".drawer-foot .btn.indigo");
        if (save && !save.classList.contains("hidden")) save.click();
      } else if (onGenerator && !anyModalOpen && !e.repeat) saveTicket(false);
    } else if (e.key === "Enter" && onGenerator && !anyModalOpen) {
      e.preventDefault();
      // Same as the Copy Note button - photos included when the note has any.
      copyNote();
    }
  });
}

// /?page=settings opens that page directly, and &open=calls|d365|sheet|features
// slides that drawer in over it. That is for one arrival: the address is put
// back to plain "/" straight away, or every later reload of this tab (and a
// tab the browser restores) would open the same drawer again instead of the
// Note Generator - which is what saving Features left behind.
function openDeepLink() {
  const params = new URLSearchParams(location.search);
  const startPage = params.get("page");
  if (startPage) switchPage(startPage);
  const startDrawer = params.get("open");
  if (startDrawer) openDrawer(startDrawer);
  if (startPage || startDrawer) {
    try { history.replaceState(null, "", location.pathname); } catch (e) { /* the address just stays */ }
  }
}

function init() {
  disableBrowserAutofill();
  initThemeControls();
  disableProfileAutofill();

  if ($("dateTime")) $("dateTime").value = new Date().toLocaleString();
  // The standing rotation loads before the draft, which may override it for
  // this one note (see restoreFormState).
  ensureVersionBadge();
  initCallType();
  initCallCard();
  initAlerts();
  initSettingsTabs();
  initTransfer();
  initRequired();
  initFiMore();
  initEnvCollapsed();
  // Restore any in-progress entry from a previous (possibly crashed) session.
  restoreFormState();
  startFiTimerClock();

  initNav();
  initGeneratorForm();
  initSettingsPage();
  initListPanels();
  initMacros();
  initKeyboard();

  // Flush any pending (debounced) autosave before the tab goes away.
  window.addEventListener("beforeunload", saveFormState);

  // Initial load: managed lists for the comboboxes, macros for expansion,
  // settings for the D365 link.
  loadAllLists();
  loadMacros();
  const settingsReady = loadSettings();
  update();
  initIncomingCalls();
  initSheet();
  initRoster();
  initUpdates();
  initImportReport();
  initPhotos();
  initD365();
  initDrawers();
  const featuresReady = initFeatures();

  // What needs the feature switches first: an off feature must never fetch
  // or show.
  Promise.all([featuresReady, settingsReady]).then(() => {
    loadPhotos();
    pollIncoming();
    openDeepLink();
  });
}

document.addEventListener("DOMContentLoaded", init);
