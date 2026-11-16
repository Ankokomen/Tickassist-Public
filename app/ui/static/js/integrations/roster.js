/* Tech roster: after a ticket is saved, check its Contact Name + Phone against
   the roster sheet and add the pair (with the Dealer) to the next empty row
   when it isn't there. See services/roster.py. */

import { api } from "../core/api.js";
import { $, on } from "../core/dom.js";
import { confirmModal, showToast } from "../core/ui.js";
import { featureOn } from "../features.js";
import { settingsCache } from "../pages/settings.js";

const MIN_DIGITS = 7;

function say(text, kind) {
  const el = $("roster-status");
  if (!el) return;
  el.textContent = text || "";
  el.className = `cw-status${kind ? " " + kind : ""}${text ? "" : " hidden"}`;
}

// Never in the way of saving: the ticket is already stored when this runs, and
// every problem here is only a message.
export async function rosterAfterSave(ticket) {
  try {
    const s = settingsCache || {};
    if (!featureOn("roster") || !s.roster_url || !s.roster_key || s.roster_mode === "off") return;
    const name = (ticket.contact || "").trim();
    const phone = (ticket.phone || "").trim();
    if (!name || phone.replace(/\D/g, "").length < MIN_DIGITS) return;
    const found = await api("POST", "/api/roster/check", { name, phone });
    if (found.result !== "missing") return;
    // The number is there under other names: a second person on a shared
    // line, or the same person typed differently? That is never guessed.
    const others = found.same_number || [];
    if (others.length) {
      const ok = await confirmModal("This number is already in the roster",
        `${phone} is in the roster sheet as ${others.join(", ")}. Add ${name} as another person on that number?`,
        `Add ${name}`);
      if (!ok) return;
    } else if (s.roster_mode !== "auto") {
      const ok = await confirmModal("Add to the tech roster?",
        `${name} (${phone}) is not in the roster sheet. Add them to the next empty row?`, "Add");
      if (!ok) return;
    }
    const done = await api("POST", "/api/roster/add", { name, phone, dealer: (ticket.dealer_name || "").trim() });
    showToast(done.result === "added" ? `Added ${name} to the roster` : `${name} is already in the roster`,
      done.result === "added" ? "green" : "slate");
  } catch (err) {
    showToast("Roster: " + err.message, "red");
  }
}

export function initRoster() {
  on("btn-roster-test", "click", async () => {
    say("Testing...", "");
    try {
      await api("POST", "/api/roster/test", { roster_url: $("roster-url").value, roster_key: $("roster-key").value });
      say("Connected - the script answered.", "running");
    } catch (err) { say(err.message, "error"); }
  });
  on("btn-roster-script", "click", async () => {
    const box = $("roster-script-box");
    if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
    try {
      $("roster-script").value = (await api("GET", "/api/roster/script")).script;
      box.classList.remove("hidden");
    } catch (err) { say(err.message, "error"); }
  });
  on("btn-roster-copy", "click", async () => {
    const area = $("roster-script");
    try { await navigator.clipboard.writeText(area.value); } catch (e) { area.select(); document.execCommand("copy"); }
    showToast("Script copied", "green");
  });
}
