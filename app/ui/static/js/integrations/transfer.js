/* ---- Call transfer --------------------------------------------------------- */

import { api } from "../core/api.js";
import { $, escapeHtml, getVal, on } from "../core/dom.js";
import { confirmModal, showToast } from "../core/ui.js";
import { markDrawerClean, openDrawerName } from "./drawers.js";
import { loadSettings, settingsCache } from "../pages/settings.js";

// Ported from the Call Triage page. The call's ContactID arrives with the
// screen pop (/call?phone={ANI}&contactId={CONTACTID}); the contact name and
// case number are the Note Generator's own fields. Sending goes through the
// server (POST /api/transfer), which posts to the address set under Transfer
// setup. A transfer moves a live caller, so it always asks first, and warns
// when the call ID belongs to a different number than the note shows.
export let transferCall = null;          // { contactId, digits, phone }
let transferEquip = [];           // from /api/transfer/config
let transferConfigured = false;
// The address the Call Triage page posted to (a saved one in Settings wins).
const DEFAULT_TRANSFER_URL = "https://planmecawiki.com/tools/signal.php";

// CAS plus 7 digits, from the active series (CAS0450000 and up).
function transferCaseOk(cas) { return /^CAS\d{7}$/.test(cas) && parseInt(cas.slice(3), 10) >= 450000; }

const TRANSFER_GUESS = [
  [/pro\s*one/i, "proone"], [/pro\s*sensor/i, "prosensor"], [/pro\s*max/i, "promax"],
  [/viso/i, "viso"], [/cad\s*cam|cerec|primescan/i, "cadcam"],
];

export function noteTransferCall(ev) {
  if (ev && ev.contact_id && ev.source !== "test") {
    transferCall = { contactId: ev.contact_id, digits: ev.digits, phone: ev.phone };
    if (openDrawerName === "transfer") renderTransfer();
  }
}

async function loadTransferConfig() {
  try {
    const c = await api("GET", "/api/transfer/config");
    transferEquip = c.equipment || [];
    transferConfigured = !!c.configured;
    const sel = $("tr-equip");
    const keep = sel.value;
    sel.innerHTML = '<option value="">-- Select Equipment / Category --</option>' +
      transferEquip.map((e) => `<option value="${escapeHtml(e.key)}">${escapeHtml(e.label)}</option>`).join("");
    sel.value = keep;
  } catch (e) { /* feature off or server restarting */ }
}

function renderTransfer() {
  const digits = getVal("phone").replace(/\D/g, "");
  $("tr-ani").textContent = getVal("phone") || "--";
  const callEl = $("tr-call");
  if (transferCall) {
    callEl.textContent = `…${transferCall.contactId.slice(-6)} (${transferCall.phone})`;
    callEl.classList.remove("bad");
  } else {
    callEl.textContent = "None captured";
    callEl.classList.add("bad");
  }
  $("tr-contact").textContent = getVal("contact") || "(none)";
  const cas = getVal("caseNumber").toUpperCase();
  const caseOk = transferCaseOk(cas);
  $("tr-case").textContent = cas && cas !== "CAS" ? cas : "--";
  $("tr-case").classList.toggle("bad", !caseOk);
  const warn = $("tr-warn");
  let msg = "";
  if (!transferCall) msg = "No call ID has been captured, so a transfer can't be sent. The call ID is read from the browser address bar of the CXone call page (transfer_pop2.html?contactId=…), or from a screen pop with &contactId={CONTACTID}.";
  else if (digits && !digits.endsWith(transferCall.digits) && !transferCall.digits.endsWith(digits))
    msg = `The active call is ${transferCall.phone}, but this note's phone number is different. Check you are transferring the right call.`;
  warn.textContent = msg;
  warn.hidden = !msg;

  const sel = $("tr-equip");
  const guess = $("tr-guess");
  if (!sel.value) {
    const dt = getVal("deviceType");
    const hit = TRANSFER_GUESS.find(([re]) => re.test(dt));
    if (hit && transferEquip.some((e) => e.key === hit[1])) {
      sel.value = hit[1];
      guess.textContent = `Suggested from Device Type "${dt}".`;
      guess.hidden = false;
    } else guess.hidden = true;
  }
  renderTransferQueues();
  if (!transferConfigured) $("tr-setup").open = true;
}

function renderTransferQueues() {
  const box = $("tr-queues");
  const eq = transferEquip.find((e) => e.key === $("tr-equip").value);
  box.innerHTML = "";
  $("tr-prompt").hidden = !!eq;
  if (!eq) return;
  const dealer = getVal("contactType") === "Dealer";
  const queues = [...eq.queues].sort((a, b) =>
    (dealer ? (b.kind === "Dealer") - (a.kind === "Dealer") : (a.kind === "Dealer") - (b.kind === "Dealer")));
  queues.forEach((q, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn indigo tr-q";
    b.disabled = !transferConfigured || !transferCall;
    const hint = i === 0 && eq.queues.length > 1 ? " \u2022 suggested" : "";
    b.innerHTML = `<span>Transfer to ${escapeHtml(q.name)}</span><span class="tr-badge">${escapeHtml(q.kind)}${hint}</span>`;
    b.addEventListener("click", () => runTransfer(eq, q));
    box.appendChild(b);
  });
}

async function runTransfer(eq, q) {
  const cas = getVal("caseNumber").toUpperCase();
  if (!transferCaseOk(cas)) {
    showToast("Case ID must be CAS plus 7 digits, CAS0450000 or higher", "red");
    $("caseNumber").focus();
    return;
  }
  if (!transferCall) return showToast("No active call ID captured from MAX", "red");
  const ok = await confirmModal("Transfer this call?",
    `Destination: ${q.name}\nCase: ${cas}\nContact: ${getVal("contact") || "(none entered)"}\nCall: ${transferCall.phone}`,
    "Transfer");
  if (!ok) return;
  $("tr-queues").querySelectorAll("button").forEach((b) => { b.disabled = true; });
  $("tr-error").hidden = true;
  try {
    const r = await api("POST", "/api/transfer", {
      contactId: transferCall.contactId, targetSkill: q.skill, caseNumber: cas,
      contactName: getVal("contact"), equipment: eq.key,
    });
    $("tr-done-queue").textContent = r.queue;
    $("tr-done-case").textContent = r.case;
    $("tr-done-reply").textContent = `Transfer service replied HTTP ${r.status}` +
      (r.reply ? `: ${r.reply}` : " with no message.");
    $("tr-main").hidden = true;
    $("tr-done").hidden = false;
    transferCall = null;      // that call is gone; never reuse its id
    showToast(`Call transferred to ${r.queue}`, "green");
  } catch (err) {
    // Stays until dismissed or the next attempt: a toast vanishes too fast.
    $("tr-error-text").textContent = err.message;
    $("tr-error").hidden = false;
    renderTransferQueues();
  }
}

export function initTransfer() {
  loadTransferConfig();
  on("btn-tr-error-close", "click", () => { $("tr-error").hidden = true; });
  on("tr-equip", "change", () => { $("tr-guess").hidden = true; renderTransferQueues(); });
  on("btn-tr-page", "click", () => {
    if (!transferCall) return showToast("No active call ID captured from MAX", "red");
    const base = ((settingsCache && settingsCache.transfer_url) || DEFAULT_TRANSFER_URL)
      .replace(/[^\/]*$/, "") + "transfer_pop2.html";
    const p = new URLSearchParams({ contactId: transferCall.contactId });
    const digits = String(transferCall.digits || getVal("phone").replace(/\D/g, ""));
    if (digits) p.set("ani", digits);
    const cas = getVal("caseNumber").toUpperCase();
    if (/^CAS\d{7}$/.test(cas)) p.set("caseNumber", cas);
    if (getVal("contact")) p.set("contactName", getVal("contact"));
    if ($("tr-equip").value) p.set("equipment", $("tr-equip").value);
    window.open(`${base}?${p}`, "_blank");
  });
  on("btn-tr-again", "click", () => { $("tr-done").hidden = true; $("tr-main").hidden = false; $("tr-equip").value = ""; renderTransfer(); });
  on("btn-save-transfer", "click", async () => {
    try {
      await api("POST", "/api/settings", { transfer_url: getVal("tr-url") });
      markDrawerClean("transfer");
      showToast("Transfer address saved", "green");
      await loadSettings();
      await loadTransferConfig();
      renderTransfer();
    } catch (err) { showToast(err.message, "red"); }
  });
  // Open the drawer on a fresh view of the note.
  document.addEventListener("click", (e) => {
    if (e.target.closest('[data-open-drawer="transfer"]')) {
      $("tr-done").hidden = true; $("tr-main").hidden = false;
      loadTransferConfig().then(renderTransfer);
    }
  });
}
