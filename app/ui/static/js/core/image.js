/* Photos as images: fetching, scaling and re-encoding them in the browser. */

import { apiBlob } from "./api.js";
import { textToHtml } from "./clipboard.js";
import { escapeHtml } from "./dom.js";

/* ---- the note with its photos, for pasting into D365 -------------------- */
// D365's rich-text note editor takes pictures pasted with the text and stores
// them with the note. Each photo goes in as an inline image, scaled so the
// clipboard stays a sensible size; plain-text targets just get the text.
const NOTE_PHOTO_MAX = 1280;

function fetchPhoto(id) { return apiBlob(`/api/photos/${id}`, "Photo not found"); }

async function photoDataUrl(id) {
  const blob = await fetchPhoto(id);
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, NOTE_PHOTO_MAX / Math.max(bmp.width, bmp.height));
  let out = blob;
  // Small PNGs (screenshots) and small JPEGs go in as they are - sharpest text.
  if (scale < 1 || !/^image\/(png|jpeg)$/.test(blob.type) || blob.size > 1.5 * 1048576) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // transparent PNGs would turn black as JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    out = await canvasBlob(canvas, "image/jpeg", 0.85);
  }
  bmp.close();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(out);
  });
}

export async function noteHtmlWithPhotos(text, list) {
  const parts = [textToHtml(text)];
  for (let i = 0; i < list.length; i++) {
    const src = await photoDataUrl(list[i].id);
    parts.push(`<div><br></div><div><img src="${src}" alt="${escapeHtml(list[i].name || "Photo " + (i + 1))}"` +
               ` style="max-width:100%;height:auto;"></div>`);
  }
  return parts.join("");
}

// Photos are kept with their ticket (the unsaved form's are a draft set the
// save claims). They are sized for D365 on the way in:
// its default note attachment limit is 5 MB, and a phone photo is often more.
const PHOTO_MAX_EDGE = 2000;               // px, long side, when resizing
const PHOTO_KEEP_BYTES = 2.5 * 1024 * 1024; // smaller files are kept as-is
const PHOTO_KEEP_EDGE = 2560;
const PHOTO_JPEG_QUALITY = 0.85;
const PHOTO_KEEP_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error("Could not encode the image"))), type, quality));
}

// Small, browser-friendly images are kept byte for byte; anything large is
// scaled to PHOTO_MAX_EDGE - as PNG if that stays small (screenshots of text),
// otherwise as JPEG on white.
export async function preparePhoto(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch (err) {
    const heic = /hei[cf]/i.test(`${file.type} ${file.name}`);
    throw new Error(`${file.name || "That image"} can't be opened by the browser` +
      (heic ? " - iPhone HEIC photos need to be shared as JPEG" : ""));
  }
  const w = bmp.width, h = bmp.height, edge = Math.max(w, h);
  if (PHOTO_KEEP_TYPES.includes(file.type) && file.size <= PHOTO_KEEP_BYTES && edge <= PHOTO_KEEP_EDGE) {
    bmp.close();
    return { blob: file, w, h };
  }
  const scale = Math.min(1, PHOTO_MAX_EDGE / edge);
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (file.type === "image/png") {
    ctx.drawImage(bmp, 0, 0, cw, ch);
    const png = await canvasBlob(canvas, "image/png");
    if (png.size <= PHOTO_KEEP_BYTES) { bmp.close(); return { blob: png, w: cw, h: ch }; }
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(bmp, 0, 0, cw, ch);
  bmp.close();
  return { blob: await canvasBlob(canvas, "image/jpeg", PHOTO_JPEG_QUALITY), w: cw, h: ch };
}

// The clipboard only takes PNG images, so other formats are converted.
async function photoPngBlob(id) {
  const blob = await fetchPhoto(id);
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width; canvas.height = bmp.height;
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close();
  return canvasBlob(canvas, "image/png");
}

export async function copyPhoto(id) {
  if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
    throw new Error("This browser can't copy images - use Save instead");
  }
  // Handing ClipboardItem the promise keeps the click's permission alive
  // while the image is fetched and converted.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": photoPngBlob(id) })]);
}
