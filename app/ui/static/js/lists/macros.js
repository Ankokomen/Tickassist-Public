/* ---- shorthand macros --------------------------------------------------- */

import { api } from "../core/api.js";
import { $, escapeHtml, on } from "../core/dom.js";
import { TRASH_SVG } from "../core/icons.js";
import { confirmModal, showToast } from "../core/ui.js";

let macrosCache = [];

export async function loadMacros() {
  try {
    const data = await api("GET", "/api/macros");
    macrosCache = data.macros || [];
    renderMacroList();
  } catch (err) { showToast(err.message, "red"); }
}

function renderMacroList() {
  const list = $("macro-list");
  if (!list) return;
  list.innerHTML = macrosCache.length
    ? macrosCache.map((m) => {
      // Single-line preview: show newlines as a subtle return glyph.
      const preview = escapeHtml(m.expansion).replace(/\r?\n/g, ' <span class="macro-nl">&crarr;</span> ');
      return `
      <div class="macro-row">
        <span class="trigger">\\${escapeHtml(m.trigger)}</span>
        <span class="arrow">&rarr;</span>
        <span class="expansion" title="${escapeHtml(m.expansion)}">${preview}</span>
        <button class="icon-btn" data-del-macro="${m.id}" title="Remove macro">${TRASH_SVG}</button>
      </div>`;
    }).join("")
    : `<div class="empty">No macros yet. Add one above.</div>`;
}

async function addMacro() {
  const tEl = $("new-macro-trigger");
  const eEl = $("new-macro-expansion");
  const trigger = tEl.value.trim();
  const expansion = eEl.value;
  if (!trigger || !expansion.trim()) {
    showToast("Enter a trigger and an expansion", "red");
    return;
  }
  try {
    await api("POST", "/api/macros", { trigger, expansion });
    tEl.value = "";
    eEl.value = "";
    autosizeMacroExpansion();
    showToast("Macro added", "green");
    loadMacros();
    tEl.focus();
  } catch (err) { showToast(err.message, "red"); }
}

async function deleteMacro(id) {
  const ok = await confirmModal("Remove this macro?", "It will be permanently removed.", "Remove");
  if (!ok) return;
  try {
    await api("DELETE", `/api/macros/${id}`);
    showToast("Macro removed", "slate");
    loadMacros();
  } catch (err) { showToast(err.message, "red"); }
}

// Grow the expansion textarea to fit its content (single line until it wraps).
export function autosizeMacroExpansion() {
  const el = $("new-macro-expansion");
  if (!el || el.offsetParent === null) return; // skip while hidden (scrollHeight 0)
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

// Don't expand inside the macro-definition fields themselves.
const MACRO_EXCLUDE = new Set(["new-macro-trigger", "new-macro-expansion"]);

// Expand "\trigger" when a terminator (space / Enter / Tab) is pressed.
function handleMacroKeydown(e) {
  if (e.key !== " " && e.key !== "Enter" && e.key !== "Tab") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // shortcuts are not terminators
  if (e.shiftKey && (e.key === "Enter" || e.key === " ")) return;
  if (!macrosCache.length) return;
  const el = e.target;
  if (!el || MACRO_EXCLUDE.has(el.id)) return;
  const tag = el.tagName;
  const isText = tag === "TEXTAREA" ||
    (tag === "INPUT" && /^(text|tel|search|email|url|)$/i.test(el.type));
  if (!isText) return;
  if (typeof el.selectionStart !== "number" || el.selectionStart !== el.selectionEnd) return;

  const pos = el.selectionStart;
  const m = el.value.slice(0, pos).match(/\\([A-Za-z0-9]+)$/);
  if (!m) return;
  const macro = macrosCache.find((x) => x.trigger.toLowerCase() === m[1].toLowerCase());
  if (!macro) return;

  e.preventDefault();
  const start = pos - m[0].length;
  let tail = "";
  if (e.key === " ") tail = " ";
  else if (e.key === "Enter" && tag === "TEXTAREA") tail = "\n";
  const insert = macro.expansion + tail;

  // Select the "\trigger" token, then replace it via execCommand so the swap
  // lands on the browser's native undo stack -> Ctrl+Z reverts the expansion.
  // execCommand also fires a native 'input' event (keeps preview + autosave).
  el.setSelectionRange(start, pos);
  let done = false;
  try { done = document.execCommand("insertText", false, insert); }
  catch (err) { done = false; }
  if (!done) {
    // Fallback (no execCommand): still works, just not natively undoable.
    el.value = el.value.slice(0, start) + insert + el.value.slice(pos);
    const caret = start + insert.length;
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

// Add / delete, and the expansion engine on every field.
export function initMacros() {
  on("btn-add-macro", "click", addMacro);
  on("new-macro-trigger", "keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("new-macro-expansion").focus(); }
  });
  on("new-macro-expansion", "keydown", (e) => {
    // Enter adds the macro; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addMacro(); }
  });
  on("new-macro-expansion", "input", autosizeMacroExpansion);
  autosizeMacroExpansion();
  on("macro-list", "click", (e) => {
    const del = e.target.closest("[data-del-macro]");
    if (del) deleteMacro(del.dataset.delMacro);
  });
  // Capture phase so the terminator keystroke is pre-empted in any field.
  document.addEventListener("keydown", handleMacroKeydown, true);
}
