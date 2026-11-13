/* ---- generator: editing a saved ticket ----------------------------------- */

import { $, getVal } from "../core/dom.js";
import { setCallType, standingCallType } from "./calltype.js";
import { revealEnvIfFilled } from "./env-section.js";
import { FIELD_MAP, normalizeResolutionStatus, setOs } from "./fields.js";
import { update } from "./preview.js";
import { checkRepeatCaller } from "./repeat-caller.js";
import { clearSheetRow, sheetLookup } from "../integrations/sheets.js";
import { rememberListedValues } from "../lists/lists.js";
import { loadPhotos } from "../photos.js";

// While set, the Save button becomes "Update Ticket" and PUTs in place.
// `page` is where to go back to once the edit is finished, if anywhere.
export let editing = null; // { id, label, page }

let saveLabel = "Save Ticket";
export function setSaveLabel(text) { saveLabel = text; renderEditBanner(); }

function renderEditBanner() {
  // The Case Entry rotation control belongs to an open ticket, so it comes and
  // goes with the edit session.
  const caseRotation = $("case-rotation");
  if (caseRotation) caseRotation.classList.toggle("hidden", !editing);

  const banner = $("edit-banner");
  if (!banner) return;
  banner.classList.toggle("hidden", !editing);
  if (editing) $("edit-banner-label").textContent = editing.label;
  const save = $("btn-save");
  if (save) save.textContent = editing ? "Update Ticket" : saveLabel;
}

export function setEditing(state) {
  const changed = (editing && editing.id) !== (state && state.id);
  editing = state;
  renderEditBanner();
  if (changed) loadPhotos();
}

export function startEditing(ticket, page) {
  const label = ticket.case_number && ticket.case_number !== "CAS"
    ? ticket.case_number : `#${ticket.id}`;
  setEditing({ id: ticket.id, label, page });
}

export function loadTicketIntoForm(t) {
  for (const [col, id] of Object.entries(FIELD_MAP)) {
    const el = $(id);
    if (!el) continue;
    if (col === "res_status") el.value = normalizeResolutionStatus(t[col]);
    else el.value = t[col] || "";
  }
  // Show the rotation this note was taken on, without moving the standing one:
  // reopening an old note must not change what the next blank form defaults to.
  setCallType(t.call_type || standingCallType, false);
  revealEnvIfFilled();
  checkRepeatCaller();
  setOs(t.os_name);
  rememberListedValues();
  clearSheetRow();
  update();
  if (getVal("imagingPackage")) sheetLookup(false, true);
}
