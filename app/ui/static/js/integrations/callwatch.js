/* ---- incoming calls (CXone MAX) ------------------------------------------ */

import { api } from "../core/api.js";
import { $, escapeHtml, fireInput, getVal, on } from "../core/dom.js";
import { showToast } from "../core/ui.js";
import { featureOn } from "../features.js";
import { editing } from "../generator/edit-session.js";
import { hasCaseNumber } from "../generator/fields.js";
import { update } from "../generator/preview.js";
import { markDrawerClean, openDrawerName } from "./drawers.js";
import { renderIntegrations } from "./status.js";
import { noteTransferCall, transferCall } from "./transfer.js";
import { loadSettings } from "../pages/settings.js";
import { showCallCard, updateCallCard } from "../theme/lcars-callcard.js";

// The server reads the caller's number off the MAX window / its notifications
// (callwatch.py) or receives it from a screen pop, and this long-polls for it.
// A pending fetch is not subject to background-tab timer throttling, so the
// number lands even while TickAssist sits behind MAX.
//
// Rule: it fills Phone Number only when that field is empty and no saved
// ticket is open. Otherwise the number is offered in a line under the field -
// a call ringing in must never overwrite the note still being written.
let incomingSeq = null;
export let incomingPending = null; // { phone, digits, contactType } offered but not yet used
// A call whose number the caller withheld: nothing to fill, so it is said
// under Phone Number until a number is typed. { contactType }
let withheldCall = null;
// The number this page itself put in Phone Number, so a caller type that MAX
// draws a moment after the number can still be applied to the same call -
// and never to a number the user typed.
let incomingFilledDigits = "";

// Set Contact Type from the call, if the rule named one of the dropdown's own
// options (matched case-insensitively). Fired as input so the Dealer field
// shows or hides and the preview updates exactly as for a manual pick.
// Contact Type came from the call's own skill (current, so it outranks
// whatever the caller was on an earlier ticket).
let incomingTypeFromSkill = false;
// What fillKnownCaller put in, so a later correction can undo just that.
export let knownCallerFill = null; // { digits, contact, dealer, type, typeBefore }
// Contact Type was picked by hand on this note. Programmatic changes (a MAX
// skill, a known caller, an import) fire untrusted events and do not count.
let contactTypePicked = false;
const DEFAULT_CONTACT_TYPE = "End User";

// The form was cleared: nothing on it came from a call any more.
export function resetIncomingState() {
  withheldCall = null;
  incomingFilledDigits = "";
  incomingTypeFromSkill = false;
  knownCallerFill = null;
  contactTypePicked = false;
}

// A hand pick of Contact Type is the user's word on it for this note; a known
// caller's previous type never replaces it.
export function markContactTypePicked() { contactTypePicked = true; }

// A number with an earlier ticket - whether it came in from MAX or was
// typed - brings back who the caller was: their name, their Contact Type and,
// for a dealer, the company, from their most recent ticket that has a name.
// Only into fields still empty: Contact Type counts as empty while it holds the
// default and nobody has picked it, and a skill MAX showed with this call
// outranks history. Never while a saved ticket is open. A typed number must be
// complete (10 digits) first, so a half-typed one cannot fill in a stranger.
export function fillKnownCaller(matches, digits) {
  if (!featureOn("known_caller")) return;
  if (editing || !digits) return;
  const fromCall = incomingFilledDigits === digits;
  if (!fromCall && digits.length < 10) return;
  if (knownCallerFill && knownCallerFill.digits === digits) return; // done once
  const last = (matches || []).find((t) => (t.contact || "").trim());
  if (!last) return;
  const filled = [];
  const fill = { digits, contact: "", dealer: "", type: "", typeBefore: "" };

  if (!getVal("contact")) {
    $("contact").value = last.contact.trim();
    fill.contact = $("contact").value;
    filled.push(fill.contact);
  }
  const lastType = (last.contact_type || "").trim();
  const lastDealer = (last.dealer_name || "").trim();
  const sel = $("contactType");
  if (lastType && !contactTypePicked && !(fromCall && incomingTypeFromSkill) &&
      sel.value === DEFAULT_CONTACT_TYPE) {
    const before = sel.value;
    const applied = applyIncomingContactType(lastType);
    if (applied && applied !== before) { fill.type = applied; fill.typeBefore = before; }
  }
  const typeNote = [];
  if (fill.type) typeNote.push(fill.type);
  if (lastDealer && sel.value === "Dealer" && !getVal("dealerName")) {
    $("dealerName").value = lastDealer;
    fill.dealer = lastDealer;
    typeNote.push(lastDealer);
  }
  if (typeNote.length) filled.push(`(${typeNote.join(", ")})`);
  knownCallerFill = fill;
  if (!filled.length) return;
  update();
  const others = [...new Set((matches || []).map((t) => (t.contact || "").trim())
    .filter((n) => n && n.toLowerCase() !== last.contact.trim().toLowerCase()))];
  showToast(`Known caller: ${filled.join(" ")}, filled from their last ticket` +
    (others.length ? ` (this number has also been ${others.join(", ")})` : ""), "indigo");
}

// The number changed (a typo fixed, a different caller, cleared): what the old
// number filled in goes back out - but only fields still holding exactly what
// was filled, so nothing typed since is touched.
export function undoKnownCallerFill() {
  const f = knownCallerFill;
  knownCallerFill = null;
  if (!f) return;
  let changed = false;
  if (f.contact && getVal("contact") === f.contact) { $("contact").value = ""; changed = true; }
  if (f.dealer && getVal("dealerName") === f.dealer) { $("dealerName").value = ""; changed = true; }
  if (f.type && !contactTypePicked && $("contactType").value === f.type) {
    $("contactType").value = f.typeBefore || DEFAULT_CONTACT_TYPE;
    changed = true;
  }
  if (changed) update();
}

function applyIncomingContactType(type) {
  const sel = $("contactType");
  if (!sel || !type) return false;
  const opt = [...sel.options].find((o) =>
    o.value.toLowerCase() === String(type).trim().toLowerCase());
  if (!opt) return false;
  if (sel.value !== opt.value) {
    sel.value = opt.value;
    fireInput(sel);
  }
  return opt.value;
}

const INCOMING_SOURCE_LABEL = {
  window: "MAX", toast: "MAX notification", "screen-pop": "CXone screen pop",
  "address-bar": "the call page",
};

function renderIncomingNotice() {
  const el = $("incoming-call");
  if (!el) return;
  const p = incomingPending;
  if (!p || getVal("phone").replace(/\D/g, "").endsWith(p.digits)) {
    incomingPending = null;
    if (withheldCall && !getVal("phone")) {
      el.innerHTML =
        `<span class="rc-text">Incoming call: <span class="rc-name">caller ID withheld</span>` +
        (withheldCall.contactType ? ` <span class="rc-meta">(${escapeHtml(withheldCall.contactType)})</span>` : "") +
        `</span>` +
        `<button type="button" class="rc-close" data-incoming-dismiss aria-label="Dismiss" title="Dismiss">` +
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
      el.classList.remove("hidden");
      return;
    }
    withheldCall = null;
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.18 2 2 0 0 1 4.08 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.1 9.9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>` +
    `<span class="rc-text">Incoming call: <span class="rc-name">${escapeHtml(p.phone)}</span>` +
    ([p.contactType, p.caseNumber].filter(Boolean).length
      ? ` <span class="rc-meta">(${escapeHtml([p.contactType, p.caseNumber].filter(Boolean).join(", "))})</span>` : "") + `</span>` +
    `<button type="button" class="btn-link" data-incoming-use>Use this number</button>` +
    `<button type="button" class="rc-close" data-incoming-dismiss aria-label="Dismiss" title="Dismiss">` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  el.classList.remove("hidden");
}

// Put a number in Phone Number exactly as if it had been typed, so formatting,
// the preview, the repeat-caller line, the timer, and autosave all follow.
// A case number MAX showed with the call (e.g. the Call Triage panel's
// "Inbound Case Reference") goes into Case ID - only while it is still blank,
// so a case number already there is never replaced. Returns what it set.
function applyIncomingCase(caseNumber) {
  const el = $("caseNumber");
  if (!el || !caseNumber || editing) return null;
  if (hasCaseNumber()) {
    if (getVal("caseNumber").toUpperCase() !== caseNumber.toUpperCase()) {
      showToast(`MAX shows case ${caseNumber} - Case ID kept as ${getVal("caseNumber")}`, "slate");
    }
    return null;
  }
  el.value = caseNumber;
  fireInput(el);
  return caseNumber;
}

function withCase(c) { return c ? `, case ${c}` : ""; }

// Returns { type, caseNumber }: the Contact Type and Case ID it set, if any.
function fillIncomingPhone(phone, contactType, caseNumber) {
  const el = $("phone");
  if (!el) return { type: null, caseNumber: null };
  el.value = phone;
  fireInput(el);
  incomingFilledDigits = phone.replace(/\D/g, "");
  knownCallerFill = null;
  const applied = applyIncomingContactType(contactType);
  incomingTypeFromSkill = !!applied;
  const setCase = applyIncomingCase(caseNumber);
  incomingPending = null;
  renderIncomingNotice();
  return { type: applied, caseNumber: setCase };
}

// Fill a call offered earlier, if the user takes it.
export function useIncomingPending() {
  if (incomingPending) {
    fillIncomingPhone(incomingPending.phone, incomingPending.contactType, incomingPending.caseNumber);
  }
}

function withType(type) { return type ? ` as ${type}` : ""; }

// Offers older than this are from a call long over; drop rather than fill.
const INCOMING_PENDING_MAX_MS = 10 * 60 * 1000;

export function takePendingIncoming() {
  const p = incomingPending;
  if (!p) return;
  if (Date.now() - p.at <= INCOMING_PENDING_MAX_MS && !getVal("phone")) {
    const set = fillIncomingPhone(p.phone, p.contactType, p.caseNumber);
    showToast(`Phone filled with the waiting caller, ${p.phone}${withType(set.type)}${withCase(set.caseNumber)}`, "indigo");
  } else {
    incomingPending = null;
    renderIncomingNotice();
  }
}

// A call from someone who withheld their number. There is nothing to put in
// Phone Number, but the call still has a skill, maybe a case number, and an
// id for Transfer call. With no number to tie it to, only a note that has no
// number yet (and is not a saved ticket) is taken to be this call's.
function handleWithheld(ev) {
  noteTransferCall(ev);
  if (!featureOn("caller_type")) ev = { ...ev, contact_type: null };
  if (!featureOn("case_from_max")) ev = { ...ev, case_number: null };
  let type = null, c = null;
  if (!editing && !getVal("phone")) {
    if (ev.contact_type && !contactTypePicked) {
      type = applyIncomingContactType(ev.contact_type);
      if (type) incomingTypeFromSkill = true;
    }
    if (ev.case_number) c = applyIncomingCase(ev.case_number);
    withheldCall = { contactType: type || (withheldCall && withheldCall.contactType) || null };
    renderIncomingNotice();
  }
  if (ev.update) {      // the skill or the case MAX showed a moment later
    if (type) showToast(`Contact Type set to ${type} from MAX`, "indigo");
    if (c) showToast(`Case ID set to ${c} from MAX`, "indigo");
    return;
  }
  showToast(`Incoming call - caller ID withheld${withType(type)}${withCase(c)}. Ask the caller for their number.`, "indigo");
}

function handleIncoming(ev) {
  if (!ev || !featureOn("calls")) return;
  if (ev.withheld) { handleWithheld(ev); return; }
  if (!ev.digits) return;
  // The Settings > Test call: report that it arrived, fill nothing.
  if (ev.source === "test") {
    if (callTestWaiter) callTestWaiter(ev);
    showCallCard(ev, true);   // LCARS: preview the call card
    return;
  }
  noteTransferCall(ev);       // the call's id, for Transfer call
  updateCallCard(ev);         // a skill / case MAX showed after the number
  if (!featureOn("caller_type")) ev = { ...ev, contact_type: null };
  if (!featureOn("case_from_max")) ev = { ...ev, case_number: null };
  const current = getVal("phone").replace(/\D/g, "");
  if (current.endsWith(ev.digits)) {
    // Same call: a case number MAX has only now shown (the triage panel can
    // load on answer) - only for a number this page filled.
    if (ev.case_number && incomingFilledDigits === ev.digits) {
      const c = applyIncomingCase(ev.case_number);
      if (c) showToast(`Case ID set to ${c} from MAX`, "indigo");
    }
    // Same call. If MAX has only now shown the skill, type the call - but
    // only when this page filled the number, never over a hand-typed one.
    if (ev.contact_type && incomingFilledDigits === ev.digits && !editing) {
      const type = applyIncomingContactType(ev.contact_type);
      if (type) {
        incomingTypeFromSkill = true;
        // A dealer copied from history no longer applies once the call itself
        // says the caller is something else - but only if it is untouched.
        if (type !== "Dealer" && knownCallerFill && knownCallerFill.dealer &&
            getVal("dealerName") === knownCallerFill.dealer) {
          $("dealerName").value = "";
          knownCallerFill.dealer = "";
          update();
        }
        showToast(`Contact Type set to ${type} from MAX`, "indigo");
      }
    }
    return;
  }
  if (incomingPending && incomingPending.digits === ev.digits) {
    // A late caller type for the call already waiting in the offer.
    if (ev.contact_type) incomingPending.contactType = ev.contact_type;
    if (ev.case_number) incomingPending.caseNumber = ev.case_number;
    renderIncomingNotice();
    return;
  }
  if (ev.update) return; // a type for a call that is no longer in play
  const from = INCOMING_SOURCE_LABEL[ev.source] || "MAX";
  showCallCard(ev);           // LCARS only; a no-op on every other theme
  if (!current && !editing) {
    const set = fillIncomingPhone(ev.phone, ev.contact_type, ev.case_number);
    showToast(`Incoming call ${ev.phone}${withType(set.type)}${withCase(set.caseNumber)} - filled from ${from}`, "indigo");
  } else {
    incomingPending = { phone: ev.phone, digits: ev.digits, at: Date.now(),
                        contactType: ev.contact_type || null,
                        caseNumber: ev.case_number || null };
    renderIncomingNotice();
    showToast(`Incoming call ${ev.phone} - Phone Number already filled, not replaced`, "slate");
  }
}

export async function pollIncoming() {
  for (;;) {
    try {
      const q = incomingSeq === null ? "" : `?since=${incomingSeq}`;
      const data = await api("GET", `/api/incoming${q}`);
      // The first answer only establishes "now": a call that rang before this
      // page opened is not replayed into it.
      if (incomingSeq !== null && data.event) handleIncoming(data.event);
      incomingSeq = data.seq;
      renderCallWatchStatus(data.watch);
    } catch (e) {
      // Server restarting or briefly unreachable: back off, then resume.
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function initIncomingCalls() {
  on("incoming-call", "click", (e) => {
    if (!incomingPending && !withheldCall) return;
    if (e.target.closest("[data-incoming-use]")) useIncomingPending();
    else if (e.target.closest("[data-incoming-dismiss]")) {
      incomingPending = null;
      withheldCall = null;
      renderIncomingNotice();
    }
  });
  // The offer goes stale once the field holds that number or is cleared and
  // refilled by hand.
  on("phone", "input", renderIncomingNotice);
  on("btn-save-callwatch", "click", saveCallWatch);
  on("btn-cw-refresh", "click", refreshCallWatch);
  on("btn-cw-openmax", "click", async () => {
    try {
      const r = await api("POST", "/api/callwatch/open-max",
        { max_url: $("cw-max-url").value.trim(), max_browser: $("cw-max-browser").value });
      showToast(r.message || "Opening MAX…", "indigo");
    } catch (e) { showToast(e.message || "Could not open MAX", "red"); }
  });
  on("btn-cw-test", "click", testCallWatch);
  // The long-poll only reports status every 25 s; while Settings or the MAX
  // drawer is open, refresh it often enough to watch it find the MAX window.
  // No ?since=, so this answers at once and never consumes a call.
  setInterval(async () => {
    const settingsOpen = $("page-settings") && $("page-settings").classList.contains("active");
    if (!settingsOpen && openDrawerName !== "calls") return;
    if (!featureOn("calls")) return;
    try { renderCallWatchStatus((await api("GET", "/api/incoming")).watch); } catch (e) {}
  }, 3000);
  const pop = $("cw-pop-url");
  // Show the real port (it moves off 8765 if that one was taken).
  if (pop && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) pop.textContent = `${location.protocol}//${location.host}/call?phone={ANI}`;
  // The long-poll itself starts once the feature switches are known (main.js).
}

// The window reader's last reported status, for the tiles and Connections.
export let callWatch = null;

export function renderCallWatchStatus(w) {
  if (!w) return;
  callWatch = w;
  renderIntegrations();
  const el = $("cw-status");
  if (!el) return;
  const state = w.state || "off";
  let text = w.message || "";
  if (state === "running" && w.titles && w.titles.length) {
    text += ` Watching: ${w.titles.map((t) => `"${t}"`).join(", ")}.`;
  }
  const lc = w.last_call;
  if (lc && lc.withheld) {
    text += lc.contact_type
      ? ` Last call: caller ID withheld, Contact Type ${lc.contact_type}, from "${lc.matched}".`
      : " Last call: caller ID withheld.";
  }
  if (lc && lc.phone) {
    text += lc.contact_type
      ? ` Last call ${lc.phone}: Contact Type ${lc.contact_type}, from "${lc.matched}".`
      : ` Last call ${lc.phone}: no caller-type rule matched` +
        (lc.context && lc.context.length
          ? ` - it came with: ${lc.context.map((t) => `"${t}"`).join(", ")}.`
          : ".");
  }
  if (lc && lc.phone && lc.case_number) text += ` Case ${lc.case_number}.`;
  if (w.ambiguous && w.ambiguous.numbers) {
    text += ` Last skipped (several new numbers at once): ${w.ambiguous.numbers.join(", ")}` +
      ` - add any that are not callers to the list below.`;
  }
  el.textContent = text || "Off.";
  el.dataset.state = state;
  // The reader can see the call page's id right now: use it even if this
  // page missed the moment it appeared (opened or reloaded mid-call).
  if (w.call_page_id && featureOn("calls") &&
      (!transferCall || transferCall.contactId !== w.call_page_id)) {
    const d = String(w.call_page_phone || "");
    noteTransferCall({ contact_id: w.call_page_id, digits: d,
                       phone: d ? `${d.slice(-10, -7)}-${d.slice(-7, -4)}-${d.slice(-4)}` : "" });
  }
  renderCallDiag(w);
}

// What the reader can see right now, plus the result of the last Test.
let callTestLine = "";
let callTestWaiter = null; // resolves when the test call reaches this page

function renderCallDiag(w) {
  const el = $("cw-diag");
  if (!el || !w) return;
  const lines = [];
  if (callTestLine) lines.push(callTestLine);
  let seen = false;
  (w.scan || []).forEach((s) => {
    let line = `\"${s.title}\": ${s.items == null ? "?" : s.items} text items read`;
    if (s.doc === 1) line += ", page content readable";
    else if (s.doc === 0) line += ", page content NOT readable";
    if (s.numbers && s.numbers.length) { seen = true; line += `. Numbers visible now: ${s.numbers.join(", ")}`; }
    else line += ". No phone numbers visible now";
    lines.push(line + ".");
    if (s.hint) lines.push(`-> ${s.hint}`);
  });
  if (w.state === "running" && w.scan_ms != null) {
    // A scan should take a fraction of a second; a call is noticed that much late.
    lines.push(`Last scan took ${w.scan_ms < 1000 ? w.scan_ms + " ms" : (w.scan_ms / 1000).toFixed(1) + " s"}.` +
      (w.scan_ms > 3000 ? " That is slow: another program is keeping the browser busy, and a call will be noticed late." : ""));
  }
  if (w.browser === "connected" && w.browser_message) lines.push(w.browser_message);
  else if (w.state === "running" || w.state === "unsupported") {
    lines.push("Tip: start MAX with the Open MAX button (or the desktop shortcut) and TickAssist can read it even when it is minimized.");
  }
  if (w.state === "running") {
    if (w.address_bars) {
      lines.push(`Browser address bars read: ${w.address_bars}` +
        (w.addresses && w.addresses.length ? ` (${w.addresses.map((a) => `"${a}"`).join(", ")})` : "") + ".");
    } else {
      lines.push("No browser address bar could be read (needs an open Edge or Chrome window).");
    }
    if (w.page_text) lines.push(`Call page address shown in MAX: "${w.page_text}"`);
    lines.push(w.call_page_id
      ? `Call page seen: call ID ending ${String(w.call_page_id).slice(-6)}.`
      : "No CXone call page (transfer_pop2.html?contactId=...) seen yet.");
  }
  if (w.toasts) lines.push(`${w.toasts} matching notification${w.toasts === 1 ? "" : "s"} on screen.`);
  if (seen) lines.push("Numbers already on screen are the baseline; only a number that appears after the reader has looked counts as a caller.");
  el.textContent = lines.join("\n");
  el.hidden = !lines.length;
}

async function refreshCallWatch() {
  const btn = $("btn-cw-refresh");
  btn.disabled = true;
  try {
    callTestLine = "";
    const r = await api("POST", "/api/callwatch/refresh", {});
    renderCallWatchStatus(r.call_watch || r.watch);
    showToast(r.restarted ? "Window reader restarted - re-reading MAX"
                          : "Reader not started - see the status line",
              r.restarted ? "green" : "slate");
  } catch (err) { showToast(err.message, "red"); }
  finally { btn.disabled = false; }
}

async function testCallWatch() {
  const btn = $("btn-cw-test");
  btn.disabled = true;
  try {
    const t0 = Date.now();
    // Listen before sending, so a fast answer is not missed.
    const arrived = new Promise((resolve) => {
      callTestWaiter = resolve;
      setTimeout(() => resolve(null), 6000);
    });
    const r = await api("POST", "/api/callwatch/test", {});
    const ev = await arrived;
    callTestWaiter = null;
    callTestLine = ev
      ? `Test call: sent from the server and received by this page in ${((Date.now() - t0) / 1000).toFixed(1)} s (nothing was filled in). The link between TickAssist and the browser works.`
      : "Test call: sent, but this page did not receive it within 6 s. The browser is not getting events from the server - check for a proxy, VPN, extension or security software blocking localhost.";
    renderCallWatchStatus(r.watch);
    showToast(ev ? "Test call received" : "Test call did not arrive", ev ? "green" : "red");
  } catch (err) { callTestWaiter = null; showToast(err.message, "red"); }
  finally { btn.disabled = false; }
}

async function saveCallWatch() {
  try {
    const r = await api("POST", "/api/settings", {
      call_watch_enabled: $("cw-enabled").checked,
      max_url: $("cw-max-url").value.trim(),
      max_browser: $("cw-max-browser").value,
      call_watch_match: $("cw-match").value.trim(),
      call_watch_ignore: $("cw-ignore").value.trim(),
      call_watch_rules: $("cw-rules").value.trim(),
    });
    renderCallWatchStatus(r.call_watch);
    markDrawerClean("calls");
    showToast("Incoming-call settings saved", "green");
    loadSettings();
  } catch (err) { showToast(err.message, "red"); }
}
