/* Writing text, rich text and images to the clipboard. */

import { escapeHtml } from "./dom.js";
import { copyPhoto } from "./image.js";
import { showToast } from "./ui.js";

// D365's timeline editor is a rich-text field: pasting plain text into it
// flattens the note onto one line. Marking the same text up with <br> gives
// that editor a flavor it keeps the line breaks from. Plain-text targets are
// unaffected - they take the text/plain flavor written alongside it.
export function textToHtml(text) {
  return `<div>${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
}

// `html` may be a string or a promise of one - a promise keeps the click's
// clipboard permission while the photos are still being encoded.
export async function writeClipboard(text, html) {
  if (navigator.clipboard && window.isSecureContext) {
    // Both flavors at once; falls back to plain text on anything that can't.
    if (window.ClipboardItem && navigator.clipboard.write) {
      try {
        const htmlBlob = Promise.resolve(html || textToHtml(text))
          .then((h) => new Blob([h], { type: "text/html" }));
        await navigator.clipboard.write([new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": htmlBlob,
        })]);
        return;
      } catch (e) {
        if (html) throw e; // with photos, plain text alone would silently drop them
      }
    }
    await navigator.clipboard.writeText(text);
  } else {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

export async function copyText(text, successMsg) {
  try {
    await writeClipboard(text);
    showToast(successMsg, "green");
  } catch (err) {
    showToast("Failed to copy to clipboard", "red");
  }
}

// Seed the Windows clipboard history (Win+V): items are copied oldest-first
// with a short gap so each write registers as its own history entry. The
// last item remains on the live clipboard for a direct Ctrl+V.
// Items are strings, or { photo: id } for an image (see copyPhoto).
export async function copySequence(items) {
  for (let i = 0; i < items.length; i++) {
    if (i) await new Promise((resolve) => setTimeout(resolve, 200));
    if (typeof items[i] === "string") await writeClipboard(items[i]);
    else if (items[i].note !== undefined) await writeClipboard(items[i].note, items[i].html);
    else await copyPhoto(items[i].photo);
  }
}
