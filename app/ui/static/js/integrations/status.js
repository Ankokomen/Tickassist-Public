/* ---- integration status: Settings tiles, drawer headers, Connections ------
   One reading of each integration's health, shown in three places with the
   same dot and words. `live` decides the sidebar: only what is set up and
   switched on appears there, so a PC that uses none of them shows nothing. */

import { $, escapeHtml } from "../core/dom.js";
import { featureOn, featuresLoaded } from "../features.js";
import { callWatch } from "./callwatch.js";
import { d365State } from "./d365.js";
import { sheetHealth } from "./sheets.js";
import { settingsCache } from "../pages/settings.js";

const INTEGRATIONS = [
  { key: "calls", name: "CXone MAX" },
  { key: "d365", name: "Dynamics 365" },
  { key: "sheet", name: "Google Sheets" },
];

function integrationStatus(key) {
  const s = settingsCache || {};
  if (key === "calls") {
    const w = callWatch || s.call_watch;
    if (!w) return { state: "busy", text: "Checking…", short: "Checking", live: false };
    const st = w.state || "off";
    if (st === "unsupported") {
      return { state: "off", text: "Needs Windows - the screen pop still works", short: "Off", live: false };
    }
    if (st === "off") return { state: "off", text: "Off", short: "Off", live: false };
    if (st === "starting") return { state: "busy", text: "Starting the window reader…", short: "Starting", live: true };
    if (st === "error") return { state: "warn", text: "The window reader stopped - open for details", short: "Stopped", live: true };
    const n = w.windows || 0;
    return n
      ? { state: "ok", text: `Listening - reading ${n} MAX window${n === 1 ? "" : "s"}`, short: "Listening", live: true }
      : { state: "warn", text: "Running, but no MAX window is open", short: "No window", live: true };
  }
  if (key === "d365") {
    const d = d365State || {};
    if (!d.configured) return { state: "off", text: "Not set up", short: "Not set up", live: false };
    if (!d.signed_in) {
      return { state: "warn", text: "Signed out - New D365 Case opens the browser form", short: "Signed out", live: true };
    }
    return { state: "ok", text: `Signed in${d.user ? " as " + d.user : ""}`, short: "Signed in", live: true };
  }
  if (key === "sheet") {
    const n = (s.sheet_sources || []).filter((x) => x.url).length;
    if (!n) return { state: "off", text: "Not set up", short: "Not set up", live: false };
    if (sheetHealth && sheetHealth.error) {
      return { state: "warn", text: `Can't read the sheet: ${sheetHealth.error}`, short: "Can't read", live: true };
    }
    return { state: "ok", text: n > 1 ? `${n} sheets linked` : (sheetHealth && sheetHealth.rows ? `Linked - ${sheetHealth.rows} rows` : "Linked"),
             short: "Linked", live: true };
  }
  return { state: "off", text: "", short: "", live: false };
}

export function renderIntegrations() {
  for (const { key } of INTEGRATIONS) {
    const st = integrationStatus(key);
    document.querySelectorAll(`[data-integ-status="${key}"]`).forEach((el) => {
      el.dataset.state = st.state;
      el.querySelector(".integ-state").textContent = st.text;
      el.title = st.text;
    });
  }
  // The panel goes only when every integration in it is switched off.
  const panel = $("integrations-panel");
  if (panel) panel.classList.toggle("hidden", !INTEGRATIONS.some(({ key }) => featureOn(key)));
  renderConnections();
}

function renderConnections() {
  const box = $("conn");
  const list = $("conn-list");
  if (!box || !list) return;
  // Until the feature switches are known, an off feature could flash in.
  const rows = !featuresLoaded ? [] : INTEGRATIONS
    .filter(({ key }) => featureOn(key))
    .map((i) => ({ ...i, st: integrationStatus(i.key) }))
    .filter((i) => i.st.live);
  box.classList.toggle("hidden", !rows.length);
  // Rebuilt only when something changed, so a status poll never drops the
  // hover or keyboard focus on a row.
  const sig = JSON.stringify(rows.map((r) => [r.key, r.st.state, r.st.text]));
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.innerHTML = rows.map((r) =>
    `<button type="button" class="conn-item" data-open-drawer="${r.key}" data-state="${r.st.state}"` +
    ` title="${escapeHtml(`${r.name}: ${r.st.text}`)}">` +
    `<span class="dot"></span><span class="conn-name">${escapeHtml(r.name)}</span>` +
    `<span class="conn-state">${escapeHtml(r.st.short)}</span></button>`).join("");
}
