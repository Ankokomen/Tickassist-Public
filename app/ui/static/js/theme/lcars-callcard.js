/* ---- LCARS extras: incoming-call card and yellow / red alert ------------- */

import { api } from "../core/api.js";
import { escapeHtml } from "../core/dom.js";
import { humanAge } from "../core/format.js";
import { hook } from "../core/hooks.js";
import { featureOn } from "../features.js";
import { normalizeResolutionStatus } from "../generator/fields.js";
import { incomingPending, useIncomingPending } from "../integrations/callwatch.js";

// Everything here is LCARS-only. On any other theme the card is never built
// and the alert engine clears itself and does nothing.
export function isLcars() { return document.documentElement.dataset.theme === "lcars"; }

// A made-up but plausible stardate: thousands = years since 2000, the rest is
// how far through the year it is.
function stardate(d = new Date()) {
  const y = d.getFullYear();
  const start = new Date(y, 0, 1);
  const frac = (d - start) / (new Date(y + 1, 0, 1) - start);
  const n = Math.floor(frac * 10000) / 10;
  return `${(y - 2000) * 1000 + Math.floor(n)}.${Math.floor((n % 1) * 10)}`;
}

/* -- Incoming-call card ---------------------------------------------------- */
// Real data (name, class, dealer, last device, last issue, status) comes from
// earlier tickets with this number; the signal readouts are decoration,
// derived from the digits so a given number always reads the same, and the
// card says so. A number with no history gets "NO PRIOR RECORD".
let callCard = null;      // { el, digits, phone, test, type, caseNumber, hist }
let callCardToken = 0;

const CC_ISSUE_MAX = 90;
function ccText(s) { return escapeHtml(String(s || "").trim()); }

function ccSignal(digits) {
  const n = [...digits].reduce((a, c) => a + Number(c), 0) + digits.length * 3;
  return {
    relay: String(1 + (n % 12)).padStart(2, "0"),
    carrier: 90 + (n % 10),
    channel: `${3 + (n % 7)}.${(n * 7) % 10}`,
  };
}

function ccAge(ts) {
  const t = Date.parse(String(ts || "").replace(" ", "T"));
  if (!t) return "";
  const ago = humanAge(Date.now() - t);
  return ago === "moments" ? "MOMENTS AGO" : `${ago.toUpperCase()} AGO`;
}

function ccHtml(c) {
  const sig = ccSignal(c.digits);
  const h = c.hist;
  const last = h && h.tickets && h.tickets[0];
  const named = h && h.tickets && h.tickets.find((t) => (t.contact || "").trim());
  const rows = [];
  const row = (k, v) => { if (v) rows.push(`<dt>${k}</dt><dd>${v}</dd>`); };
  let badge = "";
  const chips = [];

  if (c.test) {
    badge = `<span class="cc-badge test">TEST TRANSMISSION</span>`;
  } else if (!featureOn("known_caller")) {
    badge = `<span class="cc-badge none">CALLER HISTORY OFF</span>`;
  } else if (h === null) {
    badge = `<span class="cc-badge scan">CROSS-REFERENCING RECORDS&hellip;</span>`;
  } else if (h.count > 0) {
    badge = `<span class="cc-badge known">KNOWN CONTACT</span>`;
  } else {
    badge = `<span class="cc-badge none">NO PRIOR RECORD</span>`;
    chips.push(`<span class="cc-chip ice">FIRST CONTACT</span>`);
  }

  row("CALLER", named ? ccText(named.contact) : "");
  row("CLASS", ccText(c.type || (last && last.contact_type)));
  row("DEALER", last && last.dealer_name ? ccText(last.dealer_name) : "");
  row("CASE", ccText(c.caseNumber));
  if (h && h.count > 0) {
    row("ON FILE", `${h.count} ${h.count === 1 ? "TRANSMISSION" : "TRANSMISSIONS"}` +
      (last ? ` &middot; LAST CONTACT ${ccAge(last.created_at)}` : ""));
    const dev = last && [last.device_type, last.serial_number].filter((x) => (x || "").trim()).join(" ");
    row("LAST DEVICE", ccText(dev));
    if (last && last.res_status) row("LAST STATUS", ccText(normalizeResolutionStatus(last.res_status)).toUpperCase());
    let issue = last ? String(last.problem || last.case_title || "").trim().replace(/\s+/g, " ") : "";
    if (issue.length > CC_ISSUE_MAX) issue = issue.slice(0, CC_ISSUE_MAX - 1).trimEnd() + "\u2026";
    row("LAST ISSUE", issue ? `&ldquo;${ccText(issue)}&rdquo;` : "");

    const t = last && Date.parse(String(last.created_at || "").replace(" ", "T"));
    if (t && Date.now() - t < 7 * 864e5) chips.push(`<span class="cc-chip tan">RETURNED WITHIN 7 DAYS</span>`);
    const st = last ? normalizeResolutionStatus(last.res_status) : "";
    if (st.startsWith("Escalated")) chips.push(`<span class="cc-chip alert">PRIOR CASE ESCALATED</span>`);
    else if (st === "Awaiting Information") chips.push(`<span class="cc-chip tan">AWAITING INFORMATION</span>`);
  }

  const canUse = !c.test && incomingPending && incomingPending.digits === c.digits;
  const canView = h && h.count > 0 && hook("callerHistory");
  return `
    <div class="cc-bar">
      <span class="cc-title">INCOMING TRANSMISSION</span>
      <span class="cc-sd">STARDATE ${stardate()}</span>
      <button type="button" class="cc-x" data-cc-close aria-label="Dismiss">&times;</button>
    </div>
    <div class="cc-body">
      <div class="cc-number">${ccText(c.phone)}</div>
      ${badge}
      ${rows.length ? `<dl class="cc-grid">${rows.join("")}</dl>` : ""}
      ${chips.length ? `<div class="cc-chips">${chips.join("")}</div>` : ""}
      <div class="cc-sig" title="Signal readouts are decoration">
        <span>RELAY ${sig.relay}</span><span>CARRIER LOCK ${sig.carrier}%</span><span>CH ${sig.channel}</span>
        <span class="cc-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      </div>
    </div>
    <div class="cc-foot">
      ${canUse ? `<button type="button" class="btn small indigo" data-cc-use>Use number</button>` : ""}
      ${canView ? `<button type="button" class="btn small" data-cc-view>View history</button>` : ""}
      <button type="button" class="btn small" data-cc-close>Dismiss</button>
      <span class="cc-note">SIGNAL DATA SIMULATED</span>
    </div>
    <div class="cc-drain"><i></i></div>`;
}

function renderCallCard() {
  if (!callCard) return;
  callCard.el.innerHTML = ccHtml(callCard);
  const bar = callCard.el.querySelector(".cc-drain i");
  if (bar) bar.addEventListener("animationend", closeCallCard);
}

function closeCallCard() {
  callCardToken++;
  const c = callCard;
  callCard = null;
  if (!c) return;
  c.el.classList.add("leaving");
  setTimeout(() => c.el.remove(), 260);
}

export async function showCallCard(ev, test = false) {
  if (!isLcars() || !ev || !ev.digits) return;
  if (callCard) {
    if (callCard.digits === ev.digits && callCard.test === test) return;  // same call
    callCard.el.remove();
    callCard = null;
  }
  const el = document.createElement("div");
  el.className = "call-card";
  el.setAttribute("role", "status");
  el.setAttribute("aria-label", "Incoming call");
  document.body.appendChild(el);
  callCard = { el, digits: ev.digits, phone: ev.phone || ev.digits, test,
               type: ev.contact_type || "", caseNumber: ev.case_number || "", hist: null };
  const token = ++callCardToken;
  renderCallCard();
  if (test || !featureOn("known_caller")) return;
  try {
    const data = await api("GET", `/api/tickets/callcard?phone=${encodeURIComponent(ev.digits)}`);
    if (!callCard || token !== callCardToken) return;   // closed or replaced
    callCard.hist = { count: data.count || 0, tickets: data.tickets || [] };
  } catch (e) {
    if (!callCard || token !== callCardToken) return;
    callCard.hist = { count: 0, tickets: [] };
  }
  renderCallCard();
}

// MAX can show the skill or case a moment after the number.
export function updateCallCard(ev) {
  if (!callCard || callCard.test || callCard.digits !== ev.digits) return;
  if (ev.contact_type) callCard.type = ev.contact_type;
  if (ev.case_number) callCard.caseNumber = ev.case_number;
  renderCallCard();
}

export function initCallCard() {
  document.addEventListener("click", (e) => {
    if (!callCard || !callCard.el.contains(e.target)) return;
    if (e.target.closest("[data-cc-close]")) return closeCallCard();
    if (e.target.closest("[data-cc-use]") && incomingPending) {
      useIncomingPending();
      return closeCallCard();
    }
    if (e.target.closest("[data-cc-view]")) {
      const digits = callCard.digits;
      closeCallCard();
      const show = hook("callerHistory");
      if (show) show(digits);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && callCard) closeCallCard();
  });
}

// The theme left LCARS: the card goes at once, without its exit animation.
export function dropCallCard() {
  if (callCard) { callCard.el.remove(); callCard = null; }
}
