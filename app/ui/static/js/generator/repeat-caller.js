/* ---- generator: repeat-caller notice ------------------------------------ */

import { api } from "../core/api.js";
import { $, escapeHtml, getVal, on } from "../core/dom.js";
import { localStamp } from "../core/format.js";
import { hook } from "../core/hooks.js";
import { editing } from "./edit-session.js";
import { fillKnownCaller, knownCallerFill, undoKnownCallerFill } from "../integrations/callwatch.js";

// Knowing you are about to take a third call from the same number changes how
// the call opens, so the generator says so as the number is typed. Matched on
// digits server-side, debounced, and rendered inline: a modal would interrupt
// typing with a customer already on the line.
let repeatLookupTimer = null;
let repeatLookupToken = 0;
// Digits the notice has been dismissed for. Scoped to the number rather than
// to the session: waving it away for this caller should not blind you to the
// next one, and it comes back if you retype a different number.
let repeatDismissedDigits = "";

export function clearRepeatCaller() {
  const el = $("repeat-caller");
  if (el) { el.classList.add("hidden"); el.innerHTML = ""; }
}

// "Called before - Jane Doe, \"sensor not detected\" (2 total tickets, most
// recently 8/17/26, 8:16 AM)". The name and the last thing they called about
// are what actually change how the call opens; the count and timestamp are
// supporting detail. Each part is dropped rather than faked when the earlier
// note did not record it.
const RC_ISSUE_MAX = 70;

function renderRepeatCaller(matches, phone) {
  const el = $("repeat-caller");
  if (!el) return;
  if (!matches.length) return clearRepeatCaller();

  const newest = matches[0];
  const n = matches.length;
  // The name and issue come from the most recent earlier call, which is the
  // one worth recalling - but fall back through the other matches if it did
  // not record them.
  const name = (matches.find((m) => (m.contact || "").trim()) || {}).contact || "";
  const withIssue = matches.find((m) => (m.problem || m.case_title || "").trim()) || {};
  let issue = (withIssue.problem || withIssue.case_title || "").trim().replace(/\s+/g, " ");
  if (issue.length > RC_ISSUE_MAX) issue = issue.slice(0, RC_ISSUE_MAX - 1).trimEnd() + "…";

  const bits = [];
  if (name) bits.push(`<span class="rc-name">${escapeHtml(name)}</span>`);
  if (issue) bits.push(`&ldquo;${escapeHtml(issue)}&rdquo;`);
  const lead = bits.length ? bits.join(", ") + " " : "";

  el.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>` +
    `<span class="rc-text">Called before &mdash; ${lead}` +
    `<span class="rc-meta">(${n} total ${n === 1 ? "ticket" : "tickets"}, ` +
    `most recently ${escapeHtml(localStamp(newest.created_at))})</span></span>` +
    (hook("callerHistory")
      ? `<button type="button" class="btn-link" data-repeat-phone="${escapeHtml(phone)}">View</button>` : "") +
    `<button type="button" class="rc-close" data-repeat-dismiss aria-label="Dismiss this notice" title="Dismiss">` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  el.classList.remove("hidden");
}

export function checkRepeatCaller() {
  const phone = getVal("phone");
  const digits = phone.replace(/\D/g, "");
  clearTimeout(repeatLookupTimer);
  // Whatever was being looked up is for a number that is no longer in the
  // field: its answer, still on its way, must not arrive in this one's place.
  const token = ++repeatLookupToken;
  if (knownCallerFill && knownCallerFill.digits !== digits) undoKnownCallerFill();
  if (digits.length < 7) return clearRepeatCaller();
  if (digits === repeatDismissedDigits) return clearRepeatCaller();
  repeatLookupTimer = setTimeout(async () => {
    try {
      const data = await api("GET", `/api/tickets/lookup?phone=${encodeURIComponent(phone)}`);
      // A slower earlier request must not overwrite a newer answer.
      if (token !== repeatLookupToken) return;
      // ...nor one for a number the field no longer holds (changed without typing).
      if (getVal("phone").replace(/\D/g, "") !== digits) return;
      // While editing a saved ticket, that ticket is not a previous call.
      const matches = (data.matches || [])
        .filter((t) => !(editing && Number(t.id) === Number(editing.id)));
      renderRepeatCaller(matches, phone);
      fillKnownCaller(matches, digits);
    } catch (e) { if (token === repeatLookupToken) clearRepeatCaller(); }
  }, 350);
}

// Cleared with the form: a new note gets the notice again, and a lookup begun
// for the old note is dropped rather than answered into the new one.
export function forgetRepeatDismissal() {
  repeatDismissedDigits = "";
  clearTimeout(repeatLookupTimer);
  repeatLookupToken++;
}

// "View" (there when the caller's history can be shown) jumps to it; the X
// hides the notice for this number.
export function initRepeatCaller() {
  on("repeat-caller", "click", (e) => {
    if (e.target.closest("[data-repeat-dismiss]")) {
      repeatDismissedDigits = getVal("phone").replace(/\D/g, "");
      clearTimeout(repeatLookupTimer);
      repeatLookupToken++;       // an answer still on its way would bring it back
      return clearRepeatCaller();
    }
    const btn = e.target.closest("[data-repeat-phone]");
    const show = btn && hook("callerHistory");
    if (show) show(btn.dataset.repeatPhone);
  });
}
