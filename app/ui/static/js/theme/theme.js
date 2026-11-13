/* ---- theme -------------------------------------------------------------- */

import { on } from "../core/dom.js";
import { KEYS, store } from "../core/storage.js";
import { lcarsThemeChanged } from "./lcars-alerts.js";

// "auto" (default) resolves against the OS light/dark setting and tracks it
// live; the other options pin an explicit theme.
const THEMES = ["auto", "dark", "light", "contrast", "lcars"];
const darkMedia = window.matchMedia
  ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let themePref = "auto";

function resolveTheme(pref) {
  if (pref !== "auto") return pref;
  return darkMedia && darkMedia.matches ? "dark" : "light";
}

function applyTheme(pref) {
  if (!THEMES.includes(pref)) pref = "auto";
  themePref = pref;
  document.documentElement.dataset.theme = resolveTheme(pref);
  store.set(KEYS.theme, pref);
  document.querySelectorAll(".theme-option").forEach((b) =>
    b.classList.toggle("active", b.dataset.theme === pref));
  lcarsThemeChanged();   // alert + call card follow the theme
}

function initTheme() {
  const pref = new URLSearchParams(location.search).get("theme") ||
    store.get(KEYS.theme) || "auto";
  applyTheme(pref);
  if (darkMedia && darkMedia.addEventListener) {
    darkMedia.addEventListener("change", () => {
      if (themePref === "auto") applyTheme("auto");
    });
  }
}

// The theme picker in Settings and the topbar quick toggle, which flips the
// resolved theme to an explicit light/dark.
export function initThemeControls() {
  initTheme();
  on("theme-picker", "click", (e) => {
    const b = e.target.closest(".theme-option");
    if (b) applyTheme(b.dataset.theme);
  });
  on("btn-theme-quick", "click", () =>
    applyTheme(resolveTheme(themePref) === "dark" ? "light" : "dark"));
}
