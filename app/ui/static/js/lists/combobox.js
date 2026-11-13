/* ---- reusable combobox (typeable dropdown backed by a managed list) ------ */

import { $, escapeHtml } from "../core/dom.js";
import { LISTS } from "./lists.js";

export function createCombobox(inputId, menuId, listKey, onChoose, filter) {
  const input = $(inputId);
  const menu = $(menuId);
  if (!input || !menu) return null;
  let activeIndex = -1;
  let pinned = false;   // "pick one of these" menu that stays up after the field is left

  function render() {
    const q = input.value.trim().toLowerCase();
    let items = LISTS[listKey].items || [];
    if (filter) items = filter(items);
    const matches = q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items.slice();
    menu.innerHTML = !matches.length && !q ? "" : matches.length
      ? matches.map((it) =>
          `<div class="combo-item" role="option" data-name="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>`
        ).join("")
      : `<div class="combo-empty">No matches &mdash; press Save to add "${escapeHtml(input.value.trim())}"</div>`;
    activeIndex = -1;
  }
  function open() { pinned = false; render(); menu.classList.toggle("hidden", !menu.innerHTML); }
  function close() { pinned = false; menu.classList.add("hidden"); activeIndex = -1; }
  // Show the given names (not the typed-text filter) with a note on top.
  function suggest(names, note) {
    pinned = true;
    menu.innerHTML = `<div class="combo-empty">${escapeHtml(note || "")}</div>` + names.map((n) =>
      `<div class="combo-item" role="option" data-name="${escapeHtml(n)}">${escapeHtml(n)}</div>`).join("");
    activeIndex = -1;
    menu.classList.remove("hidden");
  }
  function move(delta) {
    if (menu.classList.contains("hidden")) { open(); return; }
    const items = [...menu.querySelectorAll(".combo-item")];
    if (!items.length) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle("active", i === activeIndex));
    items[activeIndex].scrollIntoView({ block: "nearest" });
  }
  function choose(name) {
    input.value = name; close(); input.classList.remove("list-invalid");
    if (onChoose) onChoose();
  }

  input.addEventListener("focus", () => { if (!pinned) open(); });
  input.addEventListener("input", open);
  input.addEventListener("blur", () => setTimeout(() => { if (!pinned) close(); }, 120));
  document.addEventListener("mousedown", (e) => {
    if (pinned && !menu.contains(e.target) && e.target !== input) close();
  });
  input.addEventListener("keydown", (e) => {
    const isOpen = !menu.classList.contains("hidden");
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter" && isOpen) {
      // Enter takes the highlighted suggestion, else the exact match, else the
      // first suggestion; with nothing suggested it just closes the list.
      const items = [...menu.querySelectorAll(".combo-item")];
      const typed = input.value.trim().toLowerCase();
      const pick = items[activeIndex] || items.find((el) => el.dataset.name.toLowerCase() === typed) || items[0];
      if (pick) { e.preventDefault(); choose(pick.dataset.name); } else close();
    } else if (e.key === "Escape") { close(); }
  });
  menu.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".combo-item");
    if (item) { e.preventDefault(); choose(item.dataset.name); }
  });

  return { render, open, close, suggest };
}
