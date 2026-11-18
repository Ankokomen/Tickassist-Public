/* ---- Dynamics 365 deep links --------------------------------------------- */

import { api } from "../core/api.js";
import { copySequence } from "../core/clipboard.js";
import { $, escapeHtml, fireInput, getVal, on } from "../core/dom.js";
import { noteHtmlWithPhotos } from "../core/image.js";
import { KEYS, store } from "../core/storage.js";
import { confirmModal, showToast } from "../core/ui.js";
import { saveFormState } from "../generator/draft.js";
import { hasCaseNumber } from "../generator/fields.js";
import { buildNote, noteForClipboard, notePhotos } from "../generator/note.js";
import { markDrawerClean, openDrawer } from "./drawers.js";
import { renderIntegrations } from "./status.js";
import { loadSettings } from "../pages/settings.js";
import { loadPhotos, photos } from "../photos.js";

// Auth is the user's existing browser session - no API or key involved.
const D365_ORG_URL = "https://planmecausprod.crm.dynamics.com";
// The org set up under Integrations > Dynamics 365, so the links and the
// signed-in integration always point at the same D365.
function d365Org() { return (d365State.org || D365_ORG_URL).replace(/\/+$/, ""); }

// Dynamics search for a case number: how an existing case is found without the API.
function d365SearchUrl(caseNumber) {
  return `${d365Org()}/main.aspx?pagetype=search&searchText=${encodeURIComponent(caseNumber)}`;
}

// Look an existing case up via Dynamics search.
export function openInD365(caseNumber) {
  const num = (caseNumber || "").trim();
  if (!num || num === "CAS") {
    showToast("This ticket has no case number", "red");
    return;
  }
  window.open(d365SearchUrl(num), "_blank");
}

// Imaging = 766610007 in this org, BUT the case form's own logic overwrites
// casetypecode on load (verified 2026-07-21: even a minimal extraqs URL with
// only this parameter does not stick). Left null so it isn't sent; if the
// org's form customization ever changes, setting the value re-enables it.
const D365_CASETYPE_IMAGING = null;

// Generator: open a fresh case form prefilled via extraqs.
// - Title and Description are plain fields and prefill cleanly. The
//   Description carries contact (+ dealer company for dealer techs), phone,
//   and case type, since Customer/Contact on the form are LOOKUP fields:
//   a URL can only set those with the target record's GUID, which requires
//   the authenticated API - free text like a phone number cannot resolve it.
// - Timeline notes are likewise API-only records, so the finished note is
//   copied to the clipboard first; pasting it is the one manual step.
// With a Case ID already in the note the case exists, so a blank form would be
// a duplicate: search D365 for that case instead, with the note on the
// clipboard ready to paste into its timeline. Shift+click forces a new case.
export async function openNewD365Case(forceNew = false) {
  if (!forceNew && hasCaseNumber()) {
    const num = getVal("caseNumber").toUpperCase();
    const noteText = noteForClipboard(buildNote());
    const list = notePhotos();
    try {
      await copySequence([list.length ? { note: noteText, html: noteHtmlWithPhotos(noteText, list) } : noteText]);
      showToast(`Searching D365 for ${num} - the note is on the clipboard, Ctrl+V pastes it into the timeline`, "green");
    } catch (err) {
      showToast(`Searching D365 for ${num} (could not load the clipboard)`, "amber");
    }
    window.open(d365SearchUrl(num), "_blank");
    return;
  }
  const title = getVal("caseTitle");
  const contact = getVal("contact");
  const phone = getVal("phone");

  // Values are encoded individually, then the whole extraqs string again -
  // the double encoding is what D365's URL-addressing scheme expects.
  // casetypecode goes first: if D365 chokes partway through the parameter
  // list (the multiline description is the riskiest), it still lands.
  const fields = [];
  if (D365_CASETYPE_IMAGING != null) fields.push(`casetypecode=${D365_CASETYPE_IMAGING}`);
  if (title) fields.push(`title=${encodeURIComponent(title)}`);
  fields.push(`description=${encodeURIComponent(d365Description())}`);

  // Clipboard history queue, copied oldest-first so Win+V lists (top-down):
  // phone, contact, serial, note - and Ctrl+V pastes the phone immediately.
  // The note carries its photos inline, so one paste brings both.
  const noteText = noteForClipboard(buildNote());
  const list = notePhotos();
  const queue = [
    list.length ? { note: noteText, html: noteHtmlWithPhotos(noteText, list) } : noteText,
    getVal("serialNumber"),
    contact,
    phone,
  ].filter((v) => typeof v !== "string" || v.trim());
  try {
    await copySequence(queue);
    showToast("Clipboard loaded - Ctrl+V pastes the phone; Win+V has contact, serial, and the note" +
      (list.length ? ` (with its ${list.length} photo${list.length === 1 ? "" : "s"})` : ""), "green");
  } catch (err) {
    showToast("Failed to load the clipboard", "red");
  }
  window.open(
    `${d365Org()}/main.aspx?etn=incident&pagetype=entityrecord` +
    `&extraqs=${encodeURIComponent(fields.join("&"))}`,
    "_blank"
  );
}

/* ---- Dynamics 365 integration -------------------------------------------- */
// Signed in (Settings > Dynamics 365), "New D365 Case" creates the case through
// the Dataverse API instead of opening a prefilled form, and "Send to D365"
// adds the note to an existing case. Signed out, everything behaves as before.
export let d365State = { configured: false, signed_in: false, user: "", org: "" };
let d365Dialog = null; // { mode, matches, selected, case, tab }

function d365Description() {
  const contact = getVal("contact");
  const dealer = $("contactType").value === "Dealer" ? getVal("dealerName") : "";
  const phone = getVal("phone");
  const lines = [];
  if (contact) lines.push(`CONTACT: ${contact}${dealer ? " - " + dealer : ""}`);
  if (phone) lines.push(`PHONE / CUSTOMER LOOKUP: ${phone}`);
  lines.push("CASE TYPE: Imaging");
  return lines.join("\n");
}

export function setD365State(st) {
  if (st) d365State = st;
  const signedIn = !!d365State.signed_in;
  $("btn-d365-note")?.classList.toggle("hidden", !signedIn);
  const nb = $("btn-new-d365-case");
  if (nb) {
    nb.title = signedIn
      ? "Create the case in D365 - customer, title, description, note and photos"
      : "Open a new D365 case with the title prefilled - or, with a Case ID entered, search D365 for that case";
  }
  renderIntegrations();
  const status = $("d365-status");
  if (!status) return;
  status.dataset.state = signedIn ? "running" : "";
  status.textContent = signedIn
    ? `Signed in${d365State.user ? " as " + d365State.user : ""} to ${d365State.org}.`
    : d365State.configured
      ? "Not signed in. Press Sign in - a Microsoft sign-in tab opens."
      : "Not set up yet: IT registers TickAssist once (see Setup for IT), then fill in the IDs below.";
  $("btn-d365-signin").classList.toggle("hidden", signedIn);
  $("btn-d365-signout").classList.toggle("hidden", !signedIn);
  $("btn-d365-test").classList.toggle("hidden", !signedIn);
}

function fillChoiceSelect(id, options, current) {
  const sel = $(id);
  if (!sel) return;
  const opts = [...(options || [])];
  if (current !== "" && current != null && !opts.some((o) => String(o.value) === String(current))) {
    opts.push({ value: current, label: `Value ${current}` });
  }
  sel.innerHTML = `<option value="">(leave blank)</option>` + opts.map((o) =>
    `<option value="${escapeHtml(String(o.value))}">${escapeHtml(o.label)} (${escapeHtml(String(o.value))})</option>`).join("");
  sel.value = current == null ? "" : String(current);
}

export function loadD365Settings(s) {
  if (!$("d365-org")) return;
  $("d365-org").value = s.d365_org_url || "";
  $("d365-tenant").value = s.d365_tenant_id || "";
  $("d365-client").value = s.d365_client_id || "";
  $("d365-custmode").value = s.d365_customer_mode || "account";
  $("d365-extra").value = s.d365_case_extra || "";
  $("d365-html").checked = s.d365_note_html !== false;
  const choices = store.getJSON(KEYS.d365Choices, {});
  fillChoiceSelect("d365-casetype", choices.casetypecode, s.d365_case_type || "");
  fillChoiceSelect("d365-origin", choices.caseorigincode, s.d365_case_origin || "");
  setD365State(s.d365);
}

async function saveD365Settings(quiet = false) {
  const extra = $("d365-extra").value.trim();
  if (extra) {
    try {
      const v = JSON.parse(extra);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    } catch (e) {
      showToast('Other case fields must be JSON, like {"prioritycode": 2}', "red");
      return false;
    }
  }
  try {
    const res = await api("POST", "/api/settings", {
      d365_org_url: $("d365-org").value.trim(),
      d365_tenant_id: $("d365-tenant").value.trim(),
      d365_client_id: $("d365-client").value.trim(),
      d365_case_type: $("d365-casetype").value,
      d365_case_origin: $("d365-origin").value,
      d365_customer_mode: $("d365-custmode").value,
      d365_case_extra: extra,
      d365_note_html: $("d365-html").checked,
    });
    setD365State(res.d365);
    markDrawerClean("d365");
    if (!quiet) showToast("Dynamics 365 settings saved", "green");
    loadSettings();
    return true;
  } catch (err) { showToast(err.message, "red"); return false; }
}

let d365Waiting = false;      // already watching for a sign-in to finish
async function d365SignIn() {
  if (!(await saveD365Settings(true))) return;
  if (!d365State.configured) {
    showToast("Fill in the D365 URL, Tenant ID and Client ID first", "red");
    return;
  }
  window.open("/d365/login", "_blank");
  $("d365-status").textContent = "Waiting for the Microsoft sign-in tab...";
  if (d365Waiting) return;      // pressed again: the tab is reopened, one watch is enough
  d365Waiting = true;
  try {
    const until = Date.now() + 5 * 60 * 1000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const st = await api("GET", "/api/d365/status");
        if (st.signed_in) {
          setD365State(st);
          showToast(`Signed in to D365${st.user ? " as " + st.user : ""}`, "green");
          return;
        }
      } catch (e) { /* keep waiting */ }
    }
    setD365State();
  } finally { d365Waiting = false; }
}

async function d365SignOut() {
  try {
    setD365State(await api("POST", "/api/d365/signout", {}));
    showToast("Signed out of D365", "slate");
  } catch (err) { showToast(err.message, "red"); }
}

async function d365Test() {
  $("d365-status").textContent = "Testing...";
  try {
    const res = await api("POST", "/api/d365/test", {});
    const ch = res.form.choices || {};
    store.setJSON(KEYS.d365Choices, ch);
    fillChoiceSelect("d365-casetype", ch.casetypecode, $("d365-casetype").value);
    fillChoiceSelect("d365-origin", ch.caseorigincode, $("d365-origin").value);
    $("d365-choices-help").textContent =
      `Loaded ${(ch.casetypecode || []).length} case types and ${(ch.caseorigincode || []).length} origins from D365.`;
    const req = res.form.required || [];
    $("d365-required-help").innerHTML = req.length
      ? "Your case form also requires: " + req.map((r) =>
          `<code>${escapeHtml(r.name)}</code> (${escapeHtml(r.label)})`).join(", ") +
        ". Lookups need <code>field@odata.bind</code> with a record id."
      : "D365 reports no other required case fields.";
    $("d365-case-settings").open = true;
    setD365State();
    $("d365-status").textContent = `Connected as ${res.user.name || res.user.login || "you"} to ${d365State.org}.`;
    showToast("D365 connection works", "green");
  } catch (err) {
    setD365State();
    $("d365-status").dataset.state = "error";
    $("d365-status").textContent = err.message;
  }
}

/* -- the dialog -- */
function d365ShowError(msg) {
  const el = $("d365-error");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
  // A lapsed sign-in turns the buttons back to the signed-out behaviour, and
  // offers the fix right here: the D365 drawer opens over the note in hand.
  if (msg && /sign in/i.test(msg)) {
    api("GET", "/api/d365/status").then((st) => setD365State(st)).catch(() => {});
    const fix = document.createElement("button");
    fix.type = "button";
    fix.className = "btn-link";
    fix.dataset.d365Fix = "";
    fix.textContent = "Sign in again";
    el.append(" ", fix);
  }
}

function d365RenderPhotosRow() {
  const row = $("d365-photos-row");
  const fresh = photos.filter((p) => !p.d365_sent_at);
  const sent = photos.length - fresh.length;
  row.classList.toggle("hidden", !photos.length);
  if (!photos.length) return;
  if (fresh.length) {
    $("d365-photos-label").textContent = `Attach ${fresh.length} photo${fresh.length === 1 ? "" : "s"}` +
      (sent ? ` (${sent} already sent)` : "");
    $("d365-send-photos").checked = true;
  } else {
    $("d365-photos-label").textContent = `Attach the ${sent} photo${sent === 1 ? "" : "s"} again (already sent)`;
    $("d365-send-photos").checked = false;
  }
}

function d365PhotoIds() {
  if (!$("d365-send-photos").checked || !photos.length) return [];
  const fresh = photos.filter((p) => !p.d365_sent_at);
  return (fresh.length ? fresh : photos).map((p) => p.id);
}

function openD365Dialog(mode) {
  d365Dialog = { mode, matches: [], selected: null, case: null };
  $("d365-modal-title").textContent = mode === "create" ? "Create D365 Case" : "Send Note to D365";
  $("d365-create-body").classList.toggle("hidden", mode !== "create");
  $("d365-note-body").classList.toggle("hidden", mode !== "note");
  $("d365-go").textContent = mode === "create" ? "Create Case" : "Send to D365";
  $("d365-go").disabled = false;
  $("d365-send-note").checked = true;
  d365ShowError("");
  d365RenderPhotosRow();
  $("d365-modal").classList.remove("hidden");
}

function closeD365Dialog() {
  $("d365-modal").classList.add("hidden");
  d365Dialog = null;
}

function d365ResultLabel(m) {
  if (m.kind === "contact") {
    return `<b>${escapeHtml(m.name)}</b>` +
      (m.account_name ? ` &middot; ${escapeHtml(m.account_name)}` : "") +
      `<span class="d365-meta">${escapeHtml([m.phone, m.email].filter(Boolean).join(" · "))}</span>`;
  }
  return `<b>${escapeHtml(m.name)}</b> <span class="d365-kind">account</span>` +
    `<span class="d365-meta">${escapeHtml([m.account_number && "#" + m.account_number, m.city, m.phone].filter(Boolean).join(" · "))}</span>`;
}

function d365RenderResults(note) {
  const box = $("d365-results");
  const d = d365Dialog;
  if (!d.matches.length) {
    box.innerHTML = `<div class="d365-empty">${escapeHtml(note || "No match. Search by name or account number.")}</div>`;
    return;
  }
  box.innerHTML = d.matches.map((m, i) => `
    <label class="d365-result">
      <input type="radio" name="d365-customer" value="${i}" ${d.selected === i ? "checked" : ""}>
      <span>${d365ResultLabel(m)}</span>
    </label>`).join("");
}

async function d365Search(phone, name) {
  const d = d365Dialog;
  if (!d) return;
  const search = d.search = (d.search || 0) + 1;      // only the newest search's answer is shown
  $("d365-results").innerHTML = `<div class="d365-empty">Searching D365...</div>`;
  try {
    const q = new URLSearchParams();
    if (phone) q.set("phone", phone);
    if (name) q.set("name", name);
    const res = await api("GET", `/api/d365/customers?${q}`);
    if (d365Dialog !== d || d.search !== search) return;
    d.matches = res.matches || [];
    // One match, or one person among a contact and accounts sharing the
    // number, is picked for you; anything less clear is left to choose.
    const people = d.matches.filter((m) => m.kind === "contact");
    d.selected = d.matches.length === 1 ? 0
      : people.length === 1 && phone ? d.matches.indexOf(people[0]) : null;
    d365RenderResults(phone && !name ? `No D365 contact or account has ${phone}. Search by name.` : "");
  } catch (err) {
    if (d365Dialog !== d || d.search !== search) return;
    d.matches = [];
    d365RenderResults(err.message);
    if (/sign/i.test(err.message)) setD365State({ ...d365State, signed_in: false });
  }
}

export async function openD365Create() {
  if (hasCaseNumber()) {
    const ok = await confirmModal("This note already has a case",
      `Case ID is ${getVal("caseNumber")}. Create another case in D365 anyway?`, "Create new");
    if (!ok) return;
  }
  openD365Dialog("create");
  $("d365-title").value = getVal("caseTitle");
  $("d365-desc").value = d365Description();
  const phone = getVal("phone");
  $("d365-search").value = phone || getVal("contact");
  d365Search(phone, phone ? "" : getVal("contact"));
  setTimeout(() => $("d365-title").focus(), 0);
}

async function openD365Note() {
  if (!hasCaseNumber()) {
    showToast("Enter the Case ID first (or use New D365 Case)", "red");
    $("caseNumber").focus();
    return;
  }
  openD365Dialog("note");
  const d = d365Dialog;
  const number = getVal("caseNumber");
  $("d365-subject").value = `Technical Note - ${getVal("caseTitle") || number}`;
  $("d365-go").disabled = true;
  $("d365-case-card").textContent = `Looking up ${number} in D365...`;
  try {
    const res = await api("GET", `/api/d365/case?number=${encodeURIComponent(number)}`);
    if (d365Dialog !== d) return;
    d.case = res.case;
    const c = res.case;
    $("d365-case-card").innerHTML =
      `<b>${escapeHtml(c.number)}</b> &middot; ${escapeHtml(c.title)}` +
      `<span class="d365-meta">${escapeHtml([c.customer, c.status].filter(Boolean).join(" · "))}</span>` +
      (c.active ? "" : `<span class="d365-warn">This case is not active - D365 may refuse new notes.</span>`);
    if (!getVal("caseTitle")) $("d365-subject").value = `Technical Note - ${c.title}`;
    $("d365-go").disabled = false;
  } catch (err) {
    if (d365Dialog !== d) return;
    $("d365-case-card").textContent = "";
    d365ShowError(err.message);
  }
}

async function d365Go() {
  const d = d365Dialog;
  if (!d) return;
  d365ShowError("");
  const sendNote = $("d365-send-note").checked;
  const ids = d365PhotoIds();
  const text = noteForClipboard(buildNote());
  const go = $("d365-go");

  if (d.mode === "create") {
    const title = $("d365-title").value.trim();
    if (!title) { d365ShowError("A case needs a title."); return; }
    if (d.selected == null) { d365ShowError("Pick the customer for this case."); return; }
    const m = d.matches[d.selected];
    const mode = d365State.customer_mode || "account";
    const customer = m.kind === "account"
      ? { kind: "account", id: m.id }
      : (mode === "account" && m.account_id ? { kind: "account", id: m.account_id } : { kind: "contact", id: m.id });
    const contactId = m.kind === "contact" && customer.kind === "account" ? m.id : null;
    // Opened now, while the click still counts, so the case can show in it.
    const tab = window.open("about:blank", "_blank");
    go.disabled = true; go.textContent = "Creating...";
    try {
      const res = await api("POST", "/api/d365/case", {
        title, description: $("d365-desc").value, customer, contact_id: contactId,
        note: sendNote ? { subject: `Technical Note - ${title}`, text } : null,
        photo_ids: ids,
      });
      const c = res.case;
      if (c.number) {
        $("caseNumber").value = c.number;
        fireInput($("caseNumber"));
      }
      if (title !== getVal("caseTitle")) {
        $("caseTitle").value = title;
        fireInput($("caseTitle"));
      }
      saveFormState();
      closeD365Dialog();
      if (tab && c.url) tab.location.href = c.url; else if (tab) tab.close();
      await loadPhotos();
      if (res.note_error) {
        showToast(`Created ${c.number}, but the note didn't go: ${res.note_error}`, "red");
      } else {
        const n = res.note ? res.note.photos : 0;
        showToast(`Created ${c.number} in D365` + (res.note ? " with the note" : "") +
          (n ? ` and ${n} photo${n === 1 ? "" : "s"}` : ""), "green");
      }
    } catch (err) {
      if (tab) tab.close();
      go.disabled = false; go.textContent = "Create Case";
      d365ShowError(err.message);
    }
    return;
  }

  if (!d.case) return;
  if (!sendNote && !ids.length) { d365ShowError("Nothing to send - tick the note or photos."); return; }
  go.disabled = true; go.textContent = "Sending...";
  try {
    const res = await api("POST", "/api/d365/note", {
      number: d.case.number, incident_id: d.case.id,
      subject: $("d365-subject").value.trim(),
      text: sendNote ? text : "", photo_ids: ids,
    });
    closeD365Dialog();
    await loadPhotos();
    const n = res.note.photos;
    showToast(`Sent to ${res.case.number}` + (sendNote ? ": the note" : ":") +
      (n ? `${sendNote ? " and" : ""} ${n} photo${n === 1 ? "" : "s"}` : ""), "green");
  } catch (err) {
    go.disabled = false; go.textContent = "Send to D365";
    d365ShowError(err.message);
  }
}

export function initD365() {
  if (!$("d365-modal")) return;
  on("btn-d365-save", "click", () => saveD365Settings(false));
  on("btn-d365-signin", "click", d365SignIn);
  on("btn-d365-signout", "click", d365SignOut);
  on("btn-d365-test", "click", d365Test);
  on("btn-d365-note", "click", openD365Note);
  on("d365-modal-close", "click", closeD365Dialog);
  on("d365-cancel", "click", closeD365Dialog);
  on("d365-go", "click", d365Go);
  on("d365-modal", "click", (e) => { if (e.target === $("d365-modal")) closeD365Dialog(); });
  // "Sign in again" under a lapsed-sign-in error: the dialog steps aside for
  // the D365 drawer, and the note stays exactly as it was.
  on("d365-error", "click", (e) => {
    if (!e.target.closest("[data-d365-fix]")) return;
    closeD365Dialog();
    openDrawer("d365");
  });
  $("d365-results").addEventListener("change", (e) => {
    if (e.target.name === "d365-customer" && d365Dialog) d365Dialog.selected = Number(e.target.value);
  });
  const search = () => {
    const v = $("d365-search").value.trim();
    if (!v) return;
    const digits = v.replace(/\D/g, "");
    if (digits.length >= 7 && /^[\d\s()+.\-]+$/.test(v)) d365Search(v, "");
    else d365Search("", v);
  };
  on("d365-search-btn", "click", search);
  $("d365-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); search(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && d365Dialog && $("modal").classList.contains("hidden")) {
      e.preventDefault();
      closeD365Dialog();
    }
  });
}
