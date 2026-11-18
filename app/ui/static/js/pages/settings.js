/* ---- settings page ------------------------------------------------------ */

import { api } from "../core/api.js";
import { $, on } from "../core/dom.js";
import { KEYS, store } from "../core/storage.js";
import { showToast } from "../core/ui.js";
import { applyOpenAllSetting } from "../generator/fi-steps.js";
import { applyRequiredMarks, resetReqPanel } from "../generator/required.js";
import { renderCallWatchStatus } from "../integrations/callwatch.js";
import { loadD365Settings, setD365State } from "../integrations/d365.js";
import { drawerDirty } from "../integrations/drawers.js";
import { renderSheetSources } from "../integrations/sheets.js";
import { renderIntegrations } from "../integrations/status.js";
import { fillUpdateSettings } from "./updates.js";

const MODEL_HINTS = {
  gemini: "Suggested: gemini-2.5-flash. Get a key at aistudio.google.com.",
  anthropic: "Suggested: claude-haiku-4-5-20251001. Get a key at console.anthropic.com.",
};

// The last /api/settings answer. The integration drawers fill from it when
// they open, and the status tiles and Connections list read it.
export let settingsCache = null;

// A fresh /api/settings answer fetched outside loadSettings.
export function setSettingsCache(s) { settingsCache = s; }

// Each integration drawer fills its own fields. A drawer with edits not yet
// saved is left alone, so a background reload never wipes what is being typed.
export const DRAWER_FILLERS = {
  calls: (s) => {
    $("cw-enabled").checked = !!s.call_watch_enabled;
    $("cw-max-url").value = s.max_url || "";
    $("cw-max-browser").value = s.max_browser || "auto";
    $("cw-match").value = s.call_watch_match || "";
    $("cw-ignore").value = s.call_watch_ignore || "";
    $("cw-rules").value = s.call_watch_rules || "";
  },
  sheet: (s) => {
    renderSheetSources(s.sheet_sources || []);
    $("sheet-check-on").checked = s.sheet_check !== false;
    $("roster-url").value = s.roster_url || "";
    $("roster-key").value = s.roster_key || "";
    $("roster-mode").value = s.roster_mode || "ask";
  },
  d365: (s) => loadD365Settings(s),
  transfer: (s) => { $("tr-url").value = s.transfer_url || ""; },
};

function fillDrawers(s) {
  for (const [name, fill] of Object.entries(DRAWER_FILLERS)) {
    if (!drawerDirty(name)) fill(s);
  }
}

export async function loadSettings() {
  try {
    const s = await api("GET", "/api/settings");
    settingsCache = s;
    fillUpdateSettings(s);
    applyOpenAllSetting(s.fi_open_all);
    if ($("rpt-rules") && document.activeElement !== $("rpt-rules")) $("rpt-rules").value = s.report_rules || "";
    if ($("llm-prompt") && !aiEdited && document.activeElement !== $("llm-prompt")) $("llm-prompt").value = s.polish_prompt || "";
    // Not over what is being typed there: settings are read again whenever a
    // drawer opens or saves.
    if (!aiEdited) {
      $("llm-provider").value = s.llm_provider || "gemini";
      $("llm-model").value = s.llm_model || "";
      $("llm-key").value = s.llm_api_key || "";
    }
    $("key-status").textContent = s.api_key_set ? "A key is currently saved." : "No key saved yet.";
    $("model-help").textContent = MODEL_HINTS[$("llm-provider").value] || "";
    fillDrawers(s);
    resetReqPanel();
    applyRequiredMarks();
    renderCallWatchStatus(s.call_watch);
    setD365State(s.d365);
    renderIntegrations();
    return s;
  } catch (err) { showToast(err.message, "red"); return null; }
}

// AI Polish only. Every integration drawer saves its own fields, so saving
// one panel can never also commit half-finished edits sitting in another.
async function saveSettings() {
  try {
    await api("POST", "/api/settings", {
      llm_provider: $("llm-provider").value,
      llm_model: $("llm-model").value.trim(),
      llm_api_key: $("llm-key").value,
      polish_prompt: $("llm-prompt").value,
    });
    aiEdited = false;
    showToast("Settings saved", "green");
    loadSettings();
  } catch (err) { showToast(err.message, "red"); }
}

/* ---- Settings sub-tabs ---------------------------------------------------- */
const SETTINGS_TABS = ["general", "lists"];

function setSettingsTab(name, focus = false) {
  if (!SETTINGS_TABS.includes(name)) name = "general";
  SETTINGS_TABS.forEach((t) => {
    const tab = $(`settings-tab-${t}`);
    const pane = $(`settings-pane-${t}`);
    if (!tab || !pane) return;
    const on = t === name;
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
    pane.classList.toggle("hidden", !on);
    if (on && focus) tab.focus();
  });
  store.set(KEYS.settingsTab, name);
}

export function initSettingsTabs() {
  setSettingsTab(store.get(KEYS.settingsTab) || "general");
  on("settings-tabs", "click", (e) => {
    const b = e.target.closest("[data-settings-tab]");
    if (b) setSettingsTab(b.dataset.settingsTab);
  });
  // Left / Right / Home / End move between tabs, as on any tab strip.
  on("settings-tabs", "keydown", (e) => {
    const i = SETTINGS_TABS.findIndex((t) => $(`settings-tab-${t}`) === document.activeElement);
    if (i < 0) return;
    const n = SETTINGS_TABS.length;
    const to = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i + n - 1) % n
      : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setSettingsTab(SETTINGS_TABS[to], true);
  });
}

// AI Polish (the drawers save their own fields).
let aiEdited = false;       // the AI Polish fields hold something not saved yet
export function initSettingsPage() {
  on("btn-save-settings", "click", saveSettings);
  ["llm-provider", "llm-model", "llm-key", "llm-prompt"].forEach((id) => {
    on(id, "input", () => { aiEdited = true; });
    on(id, "change", () => { aiEdited = true; });
  });
  on("llm-provider", "change", () => {
    $("model-help").textContent = MODEL_HINTS[$("llm-provider").value] || "";
  });
  on("btn-llm-prompt-reset", "click", () => {
    $("llm-prompt").value = (settingsCache && settingsCache.polish_prompt_default) || "";
    aiEdited = true;
    showToast("Default instructions restored - press Save Settings to keep them", "indigo");
  });
}
