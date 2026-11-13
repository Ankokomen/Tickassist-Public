/* Toasts, the confirm dialog and inline status lines. */

import { $ } from "./dom.js";

export function showToast(msg, kind = "indigo") {
  const wrap = $("toast-wrap");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

let modalResolver = null;
export function confirmModal(title, body, confirmLabel = "Confirm") {
  $("modal-title").textContent = title;
  $("modal-body").textContent = body;
  $("modal-confirm").textContent = confirmLabel;
  $("modal").classList.remove("hidden");
  // Focus the confirm button so Enter confirms and there's a clear focus ring.
  setTimeout(() => $("modal-confirm").focus(), 0);
  return new Promise((resolve) => { modalResolver = resolve; });
}
export function closeModal(result) {
  $("modal").classList.add("hidden");
  if (modalResolver) { modalResolver(result); modalResolver = null; }
}

// A status line under a panel (Features, report import): hidden when empty.
export function setMessage(id, text, kind) {
  const el = $(id);
  el.textContent = text || "";
  el.className = `feat-msg${kind ? " " + kind : ""}${text ? "" : " hidden"}`;
}
