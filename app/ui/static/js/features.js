/* ---- feature switches (Settings > Features drawer) ---------------------- */

import { api } from "./core/api.js";
import { $, escapeHtml, on } from "./core/dom.js";
import { KEYS, store } from "./core/storage.js";
import { setMessage, showToast } from "./core/ui.js";
import { drawerDirty, markDrawerClean } from "./integrations/drawers.js";
import { renderIntegrations } from "./integrations/status.js";
import { loadPhotos } from "./photos.js";

// Off features are hidden by a body class (styles.css) and refused by the
// server; this copy only decides what the page offers.
let FEATURES = {};
let featureInfo = { list: [], overridden: false };
export function featureOn(key) { return FEATURES[key] !== false; }

function applyFeatures(data) {
  const before = { ...FEATURES };
  featureInfo = data || featureInfo;
  FEATURES = (data && data.features) || {};
  for (const [key, on] of Object.entries(FEATURES)) {
    document.body.classList.toggle(`feat-off-${key}`, !on);
  }
  featuresLoaded = true;
  renderFeatures();
  renderIntegrations();
  if (before.photos === false && FEATURES.photos) loadPhotos();
}

export let featuresLoaded = false;

export function renderFeatures() {
  const list = $("feat-list");
  if (!list) return;
  if (!drawerDirty("features")) list.innerHTML = (featureInfo.list || []).map((f) =>
    `<label class="feat-item">` +
    `<span class="feat-text"><span class="feat-label">${escapeHtml(f.label)}</span>` +
    `<span class="feat-desc">${escapeHtml(f.description)}</span></span>` +
    `<input type="checkbox" class="switch" data-feat="${escapeHtml(f.key)}"` +
    `${FEATURES[f.key] !== false ? " checked" : ""}></label>`).join("");
  $("feat-lock").textContent = featureInfo.overridden ? "Set for this PC" : "Office defaults";
  $("btn-feat-reset").classList.toggle("hidden", !featureInfo.overridden);
  const restart = $("feat-restart");
  restart.classList.toggle("hidden", !featureInfo.restart_needed);
  restart.textContent = featureInfo.restart_needed
    ? `TickAssist was updated while it was running (still running ${featureInfo.running_version}). ` +
      "Close the TickAssist window and start it again with run.bat before changing features."
    : "";
}

export function featMessage(text, kind) { setMessage("feat-msg", text, kind); }

export async function loadFeatures() {
  try { applyFeatures(await api("GET", "/api/features")); }
  catch (err) { featuresLoaded = true; renderIntegrations(); /* older server */ }
}

async function saveFeatures(reset) {
  featMessage("Saving...");
  const body = {};
  if (reset) {
    body.reset = true;
  } else {
    body.features = {};
    document.querySelectorAll("#feat-list [data-feat]").forEach((cb) => {
      body.features[cb.dataset.feat] = cb.checked;
    });
  }
  try {
    await api("POST", "/api/features", body);
    markDrawerClean("features");
    // Reload so every feature starts up the way it does on a fresh launch -
    // D365, photos and incoming calls all set themselves up at page load.
    store.set(KEYS.featuresSaved,
      reset ? "This PC now follows the office defaults" : "Features saved", true);
    featMessage("Saved - reloading...", "done");
    setTimeout(() => {
      location.href = location.pathname + "?page=settings&open=features";
    }, 400);
  } catch (err) {
    featMessage(err.message, "error");
    showToast(err.message, "red");
  }
}

export function initFeatures() {
  const saved = store.get(KEYS.featuresSaved, true);
  if (saved) {
    store.remove(KEYS.featuresSaved, true);
    showToast(saved, "green");
    featMessage(saved + ".", "done");
  }
  on("btn-save-features", "click", () => saveFeatures(false));
  on("btn-feat-reset", "click", () => saveFeatures(true));
  return loadFeatures();
}
