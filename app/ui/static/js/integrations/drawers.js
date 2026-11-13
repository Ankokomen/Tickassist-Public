/* ---- integration drawers ---------------------------------------------------
   Settings stays one page with no tabs: each integration's setup lives in a
   drawer that slides over whatever page is showing (index.html, INTEGRATION
   DRAWERS). It opens from its Settings tile, from the sidebar's Connections
   list, from a lapsed-sign-in error mid-note, or from ?open=<name> - never by
   switching page, so the note in hand and the layout under it stay put. One
   drawer at a time; edits not yet saved are confirmed before they are lost. */

import { $, on } from "../core/dom.js";
import { confirmModal } from "../core/ui.js";
import { featMessage, featureOn, loadFeatures, renderFeatures } from "../features.js";
import { DRAWER_FILLERS, loadSettings, settingsCache } from "../pages/settings.js";

export let openDrawerName = null;
let drawerOpener = null; // focus goes back here on close
const dirtyDrawers = new Set();
const DRAWER_MS = 260; // a touch over the slide in styles.css

export function drawerEl(name) { return document.querySelector(`.drawer[data-drawer="${name}"]`); }
export function drawerDirty(name) { return dirtyDrawers.has(name); }
export function markDrawerDirty(name) { dirtyDrawers.add(name); }
export function markDrawerClean(name) { dirtyDrawers.delete(name); }

function drawerFocusables(el) {
  return [...el.querySelectorAll(
    "button, input, select, textarea, summary, [href], [tabindex]:not([tabindex='-1'])")]
    .filter((x) => !x.disabled && x.offsetParent !== null);
}

export async function openDrawer(name, opener) {
  const el = drawerEl(name);
  if (!el) return;
  if (el.dataset.feature && !featureOn(el.dataset.feature)) return;
  if (openDrawerName === name) return;
  if (openDrawerName && !(await closeDrawer())) return;

  drawerOpener = opener || document.activeElement;
  openDrawerName = name;
  markDrawerClean(name);
  // Show what is saved now - not edits abandoned the last time it was open.
  if (name === "features") {
    renderFeatures();
  } else if (settingsCache && DRAWER_FILLERS[name]) {
    DRAWER_FILLERS[name](settingsCache);
  }

  const backdrop = $("drawer-backdrop");
  backdrop.classList.remove("hidden");
  el.classList.remove("hidden");
  el.scrollTop = 0;
  void el.offsetWidth; // start the slide from off-screen
  backdrop.classList.add("open");
  el.classList.add("open");
  document.body.classList.add("drawer-open");
  const first = drawerFocusables(el.querySelector(".drawer-body"))[0] ||
    el.querySelector("[data-drawer-close]");
  if (first) first.focus({ preventScroll: true });

  // Then refresh from the server: statuses, and the fields if still untouched.
  if (name === "features") loadFeatures();
  else loadSettings();
}

// Resolves false if the user chose to keep editing.
async function closeDrawer(force = false) {
  const name = openDrawerName;
  if (!name) return true;
  if (!force && drawerDirty(name)) {
    const ok = await confirmModal("Close without saving?",
      "The changes in this panel haven't been saved and will be lost.", "Discard changes");
    if (!ok) return false;
  }
  markDrawerClean(name);
  openDrawerName = null;
  const el = drawerEl(name);
  const backdrop = $("drawer-backdrop");
  el.classList.remove("open");
  backdrop.classList.remove("open");
  document.body.classList.remove("drawer-open");
  setTimeout(() => {
    if (openDrawerName !== name) el.classList.add("hidden");
    if (!openDrawerName) backdrop.classList.add("hidden");
  }, DRAWER_MS);
  if (name === "features") featMessage("");
  if (drawerOpener && document.contains(drawerOpener)) drawerOpener.focus({ preventScroll: true });
  drawerOpener = null;
  return true;
}

export function initDrawers() {
  // Anything marked data-open-drawer opens one: tiles, the Features button,
  // and the Connections rows (rendered later, hence the delegation).
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-open-drawer]");
    if (t) { e.preventDefault(); openDrawer(t.dataset.openDrawer, t); }
  });
  document.querySelectorAll(".drawer").forEach((el) => {
    const name = el.dataset.drawer;
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-drawer-close]")) closeDrawer();
    });
    // Any edit makes the drawer dirty until it is saved.
    const touch = (e) => {
      if (e.target.closest("[data-no-dirty]")) return;
      markDrawerDirty(name);
    };
    el.addEventListener("input", touch);
    el.addEventListener("change", touch);
  });
  on("drawer-backdrop", "click", () => closeDrawer());

  document.addEventListener("keydown", (e) => {
    if (!openDrawerName) return;
    // A dialog on top (the discard confirm) handles its own keys - including
    // the Escape that just closed it, which must not close the drawer too.
    if (e.defaultPrevented || !$("modal").classList.contains("hidden")) return;
    const el = drawerEl(openDrawerName);
    if (e.key === "Escape") {
      e.preventDefault();
      closeDrawer();
    } else if (e.key === "Tab") {
      // Keep focus inside the drawer; the page behind is under the backdrop.
      const items = drawerFocusables(el);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  });
}
