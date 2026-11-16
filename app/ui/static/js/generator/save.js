/* ---- generator: save + clear -------------------------------------------- */

import { api } from "../core/api.js";
import { $ } from "../core/dom.js";
import { confirmModal, showToast } from "../core/ui.js";
import { setCallType, standingCallType } from "./calltype.js";
import { refreshTimestamp } from "./draft.js";
import { editing, setEditing } from "./edit-session.js";
import { resetFiSteps } from "./fi-steps.js";
import { resetFiTimer } from "./fi-timer.js";
import { collectTicket, hasCaseNumber, setOs } from "./fields.js";
import { clearPolishUndo } from "./polish.js";
import { update } from "./preview.js";
import { clearRepeatCaller, forgetRepeatDismissal } from "./repeat-caller.js";
import { missingRequired, reportMissingRequired } from "./required.js";
import { resetIncomingState, takePendingIncoming } from "../integrations/callwatch.js";
import { rosterAfterSave } from "../integrations/roster.js";
import { autoRegister, ENV_COMBOS, FREE_LISTS, reportUnlisted, unlistedFields } from "../lists/lists.js";
import { switchPage } from "../pages/nav.js";
import { discardDraftPhotos, forgetPhotos, loadPhotos, photos } from "../photos.js";

// Default: insert a new ticket and reset. While editing a saved ticket, save
// updates it in place; asNew=true forks the current fields into a fresh row.
// A Case ID is required before saving so cases get created in D365 up front;
// bypass=true (Shift+Click the Save button) skips that gate.
export async function saveTicket(asNew = false, bypass = false) {
  if (!bypass && !hasCaseNumber()) {
    showToast("Enter a Case ID before saving", "red");
    const el = $("caseNumber");
    if (el) { el.focus(); el.select(); }
    return;
  }
  if (!bypass) {
    const missing = missingRequired();
    if (missing.length) { reportMissingRequired(missing); return; }
    const unlisted = await unlistedFields();
    if (unlisted.length) { reportUnlisted(unlisted); return; }
  }
  try {
    const ticket = collectTicket();
    // Auto-register any values the user typed straight into the ticket fields.
    if (ticket.contact_type === "Dealer") await autoRegister("dealers", ticket.dealer_name);
    for (const key of FREE_LISTS) await autoRegister(key, ticket[ENV_COMBOS[key][1]]);

    if (editing && !asNew) {
      // Finishing an edit: update in place, close the session, and go back
      // to where the ticket was opened from.
      const { label, page } = editing;
      await api("PUT", `/api/tickets/${editing.id}`, ticket);
      // Photos added while editing went straight onto this ticket.
      resetFields();
      if (page) switchPage(page);
      showToast(`Ticket ${label} updated`, "green");
    } else if (editing && asNew) {
      const { page } = editing;
      const saved = await api("POST", "/api/tickets", ticket);
      // The copy carries the original's photos; the original keeps its own.
      if (photos.length) {
        await api("POST", "/api/photos/copy", { from: editing.id, to: saved.ticket.id });
      }
      resetFields();
      if (page) switchPage(page);
      showToast("Saved as a new ticket", "green");
    } else {
      const saved = await api("POST", "/api/tickets", ticket);
      const n = photos.length ? (await api("POST", "/api/photos/claim",
        { ticket_id: saved.ticket.id })).claimed : 0;
      forgetPhotos();
      resetFields();
      loadPhotos();
      showToast(n ? `Ticket saved with ${n} photo${n === 1 ? "" : "s"}` : "Ticket saved", "green");
    }
    // Not awaited: the ticket is saved, the roster is a courtesy.
    rosterAfterSave(ticket);
  } catch (err) {
    showToast(err.message, "red");
  }
}

// Reset every generator field back to its default (no confirmation, no toast).
export function resetFields() {
  document.querySelectorAll(".form-panel input:not([type=radio]):not([type=checkbox]), .form-panel textarea")
    .forEach((el) => { if (el.id !== "dateTime" && el.id !== "caseNumber") el.value = ""; });
  $("caseNumber").value = "CAS";
  $("contactType").value = "End User";
  $("resStatus").value = "Resolved";
  setOs("Windows");
  resetFiSteps();
  clearPolishUndo();
  // Back to the standing rotation - clearing the form ends any edit session,
  // including one that had borrowed the other rotation.
  setCallType(standingCallType, false);
  forgetRepeatDismissal();
  resetIncomingState();
  clearRepeatCaller();
  setEditing(null);
  // Before refreshTimestamp, so its saveFormState persists the zeroed clock.
  resetFiTimer();
  refreshTimestamp(false);
  update();
  // A caller who rang in while the last note was still open is usually the
  // one on the line now that it has been saved or cleared.
  takePendingIncoming();
}

export async function clearFields() {
  const ok = await confirmModal(
    "Reset all fields?",
    "This clears the current service entry. This cannot be undone.",
    "Yes, clear"
  );
  if (!ok) return;
  const hadEdit = !!editing;
  resetFields();
  // Unsaved photos go with the rest of the form. A saved ticket's stay put.
  if (!hadEdit) await discardDraftPhotos();
  showToast("All fields reset", "slate");
}
