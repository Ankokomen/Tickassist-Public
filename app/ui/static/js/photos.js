/* Photos kept with a ticket: the grid under the note, paste, drop, copy, save. */

import { api, apiUpload } from "./core/api.js";
import { copySequence } from "./core/clipboard.js";
import { $, escapeHtml, getVal, on } from "./core/dom.js";
import { fmtBytes } from "./core/format.js";
import { TRASH_SVG } from "./core/icons.js";
import { copyPhoto, preparePhoto } from "./core/image.js";
import { confirmModal, showToast } from "./core/ui.js";
import { featureOn } from "./features.js";
import { saveFormState } from "./generator/draft.js";
import { editing } from "./generator/edit-session.js";
import { hasCaseNumber } from "./generator/fields.js";
import { openDrawerName } from "./integrations/drawers.js";

export let photos = []; // [{ id, name, mime, width, height, size }]

function photoScope() { return editing ? `ticket=${editing.id}` : "draft=1"; }

// A save just claimed the draft set; the grid reloads after the form resets.
export function forgetPhotos() { photos = []; }

export async function loadPhotos() {
  if (!featureOn("photos")) { photos = []; renderPhotos(); return; }
  const scope = photoScope();
  try {
    const data = await api("GET", `/api/photos?${scope}`);
    if (scope !== photoScope()) return; // the form moved on meanwhile
    photos = data.photos || [];
  } catch (err) {
    if (scope !== photoScope()) return;
    photos = [];
  }
  renderPhotos();
}

export async function discardDraftPhotos() {
  try { await api("POST", "/api/photos/discard-drafts"); } catch (err) { /* best effort */ }
  await loadPhotos();
}

function photoExt(mime) {
  return ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
            "image/webp": "webp", "image/bmp": "bmp" })[mime] || "img";
}

// CAS0485494-1.jpg when the case has a number, so attachments in D365 and
// files in Downloads say which case they belong to.
function photoFileName(p, index) {
  const base = hasCaseNumber() ? getVal("caseNumber").replace(/[^\w-]+/g, "") : "photo";
  return `${base}-${index + 1}.${photoExt(p.mime)}`;
}

async function addPhotos(fileList) {
  const files = [...fileList].filter((f) => f && (f.type.startsWith("image/") || /\.(hei[cf])$/i.test(f.name)));
  if (!files.length) { showToast("Those aren't image files", "red"); return; }
  const scope = photoScope();
  let added = 0;
  for (const file of files) {
    try {
      const { blob, w, h } = await preparePhoto(file);
      const stem = (file.name || "").replace(/\.[^.]+$/, "") || `pasted-${Date.now()}`;
      const name = `${stem}.${photoExt(blob.type)}`;
      await apiUpload(`/api/photos?${scope}&name=${encodeURIComponent(name)}&w=${w}&h=${h}`, blob, blob.type);
      added++;
    } catch (err) {
      showToast(err.message, "red");
    }
  }
  await loadPhotos();
  if (added) {
    showToast(`Added ${added} photo${added === 1 ? "" : "s"}` +
      (editing ? ` to ${editing.label}` : " - saved with the ticket"), "green");
  }
}

function downloadPhoto(p, index) {
  const a = document.createElement("a");
  a.href = `/api/photos/${p.id}?download=1&name=${encodeURIComponent(photoFileName(p, index))}`;
  a.download = photoFileName(p, index);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function renderPhotos() {
  const grid = $("photo-grid");
  if (!grid) return;
  const n = photos.length;
  $("photos-count").textContent = n ? `(${n})` : "";
  $("photo-empty").classList.toggle("hidden", n > 0);
  $("btn-photo-copy-all").classList.toggle("hidden", n < 2);
  $("btn-photo-save-all").classList.toggle("hidden", n < 2);
  grid.innerHTML = photos.map((p, i) => `
    <div class="photo-tile" data-photo="${p.id}">
      <img src="/api/photos/${p.id}" alt="${escapeHtml(p.name || "Photo")}" loading="lazy"
           draggable="true" data-photo-open="${p.id}"
           title="${escapeHtml(photoFileName(p, i))} - ${p.width && p.height ? `${p.width}x${p.height}, ` : ""}${fmtBytes(p.size)}. Click to open full size; drag to a folder to save it.">
      <div class="photo-actions">
        <button class="btn small" data-photo-copy="${p.id}" title="Copy the image - paste it into a D365 note">Copy</button>
        <button class="btn small" data-photo-save="${p.id}" title="Download, to attach in D365">Save</button>
        <button class="icon-btn" data-photo-del="${p.id}" title="Remove photo">${TRASH_SVG}</button>
      </div>
    </div>`).join("");
}

export function initPhotos() {
  const zone = $("photo-drop");
  if (!zone) return;
  const input = $("photo-input");
  on("btn-photo-add", "click", () => input.click());
  input.addEventListener("change", () => {
    if (input.files.length) addPhotos(input.files);
    input.value = "";
  });

  on("btn-photo-copy-all", "click", async () => {
    try {
      await copySequence(photos.map((p) => ({ photo: p.id })));
      showToast(`${photos.length} photos copied - Win+V lists them all, newest first`, "green");
    } catch (err) { showToast(err.message || "Copy failed", "red"); }
  });
  on("btn-photo-save-all", "click", async () => {
    for (let i = 0; i < photos.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, 300));
      downloadPhoto(photos[i], i);
    }
  });

  $("photo-grid").addEventListener("click", async (e) => {
    const t = e.target.closest("[data-photo-copy],[data-photo-save],[data-photo-del],[data-photo-open]");
    if (!t) return;
    const id = Number(t.dataset.photoCopy || t.dataset.photoSave || t.dataset.photoDel || t.dataset.photoOpen);
    const index = photos.findIndex((p) => p.id === id);
    if (index < 0) return;
    if (t.dataset.photoOpen) {
      window.open(`/api/photos/${id}`, "_blank");
    } else if (t.dataset.photoCopy) {
      try {
        await copyPhoto(id);
        showToast("Photo copied - paste it into the D365 note (Ctrl+V)", "green");
      } catch (err) { showToast(err.message || "Copy failed", "red"); }
    } else if (t.dataset.photoSave) {
      downloadPhoto(photos[index], index);
    } else if (t.dataset.photoDel) {
      const ok = !editing || await confirmModal("Remove this photo?",
        `It is deleted from saved ticket ${editing.label}. This cannot be undone.`, "Remove");
      if (!ok) return;
      try {
        await api("DELETE", `/api/photos/${id}`);
        await loadPhotos();
        saveFormState();
      } catch (err) { showToast(err.message, "red"); }
    }
  });

  // Dragging a photo out hands over a file (Chrome/Edge), so dropping it on
  // the desktop or a folder saves it. No URL is offered: a localhost link
  // dropped into D365 would only ever work on this PC.
  $("photo-grid").addEventListener("dragstart", (e) => {
    const img = e.target.closest("img[data-photo-open]");
    if (!img) return;
    const index = photos.findIndex((p) => p.id === Number(img.dataset.photoOpen));
    if (index < 0) return;
    const p = photos[index], name = photoFileName(p, index);
    e.dataTransfer.clearData();
    e.dataTransfer.setData("DownloadURL",
      `${p.mime}:${name}:${location.origin}/api/photos/${p.id}?download=1&name=${encodeURIComponent(name)}`);
    e.dataTransfer.effectAllowed = "copy";
    zone.dataset.dragOut = "1";
  });
  $("photo-grid").addEventListener("dragend", () => { delete zone.dataset.dragOut; });

  const hasFiles = (e) => !zone.dataset.dragOut && [...(e.dataTransfer?.types || [])].includes("Files");
  zone.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    zone.classList.add("dragging");
  });
  zone.addEventListener("dragleave", (e) => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove("dragging");
  });
  zone.addEventListener("drop", (e) => {
    zone.classList.remove("dragging");
    if (!hasFiles(e)) return;
    e.preventDefault();
    addPhotos(e.dataTransfer.files);
  });

  // Ctrl+V of a screenshot anywhere on the Note Generator adds it - except
  // into a text field when the clipboard also carries text, so pasting from
  // Word or a web page still pastes words.
  document.addEventListener("paste", (e) => {
    if (!featureOn("photos")) return;
    if (!$("page-generator").classList.contains("active")) return;
    if (document.querySelector(".modal-backdrop:not(.hidden)") || openDrawerName) return;
    const cd = e.clipboardData;
    if (!cd) return;
    const images = [...cd.items].filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile()).filter(Boolean);
    if (!images.length) return;
    const field = e.target.closest && e.target.closest("input, textarea, [contenteditable]");
    if (field && (cd.getData("text/plain") || "").trim()) return;
    e.preventDefault();
    addPhotos(images);
  });
  // The first loadPhotos waits for the feature switches (main.js).
}
