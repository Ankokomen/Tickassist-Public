/* ---- version badge ------------------------------------------------------ */

import { api } from "../core/api.js";
import { $ } from "../core/dom.js";
import { loadAllLists } from "../lists/lists.js";
import { autosizeMacroExpansion, loadMacros } from "../lists/macros.js";
import { loadSettings } from "./settings.js";

// The badge is normally substituted into the page server-side. It only lands
// unrendered if the page came from a server that predates that substitution -
// an instance still running older code while the files on disk have moved on.
// Rather than leave "{{VERSION}}" sitting in the topbar, ask the API.
export async function ensureVersionBadge() {
  const el = $("app-version");
  if (!el || !el.textContent.includes("{{")) return;
  el.textContent = "";
  try {
    const info = await api("GET", "/api/health");
    if (info && info.version) el.textContent = `v${info.version}`;
  } catch (e) { /* leave it blank - better than showing the placeholder */ }
}

/* ---- navigation --------------------------------------------------------- */

// What a page loads each time it is shown.
const shown = {
  settings: () => { loadSettings(); loadAllLists(); loadMacros(); autosizeMacroExpansion(); },
};

export function onPageShown(page, fn) { shown[page] = fn; }

// A page that isn't in this copy (an old bookmark, say) opens the generator.
export function switchPage(page) {
  if (!$(`page-${page}`)) page = "generator";
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.page === page));
  document.querySelectorAll(".page").forEach((p) =>
    p.classList.toggle("active", p.id === `page-${page}`));
  if (shown[page]) shown[page]();
}

export function initNav() {
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.addEventListener("click", () => switchPage(b.dataset.page)));
}
