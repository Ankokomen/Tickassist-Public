/* The service note: building it, copying it, and its bullets. */

import { copyText, writeClipboard } from "../core/clipboard.js";
import { $, getVal } from "../core/dom.js";
import { noteHtmlWithPhotos } from "../core/image.js";
import { showToast } from "../core/ui.js";
import { featureOn } from "../features.js";
import { callType } from "./calltype.js";
import { getOsLabel, normalizeResolutionStatus, osLine } from "./fields.js";
import { photos } from "../photos.js";

// The photos that go with the note (none when the feature is off).
export function notePhotos() { return featureOn("photos") ? photos : []; }

export async function copyNote() {
  const text = noteForClipboard(buildNote());
  const list = notePhotos();
  if (!list.length) return copyText(text, "D365 note copied!");
  try {
    await writeClipboard(text, noteHtmlWithPhotos(text, list));
    showToast(`D365 note copied with ${list.length} photo${list.length === 1 ? "" : "s"} - paste it into the note`, "green");
  } catch (err) {
    showToast("Couldn't copy the photos with the note - copy them one by one instead", "red");
  }
}

/* ---- generator: note builder -------------------------------------------- */
const NOTE_DIVIDER = "\n-------------------------------------------------\n";

export function buildNote() {
  const blocks = [];
  const divider = NOTE_DIVIDER;

  const meta = [];
  const caseId = getVal("caseNumber");
  if (caseId && caseId !== "CAS") meta.push(`SERVICE NOTE: ${caseId}`);
  const title = getVal("caseTitle");
  if (title) meta.push(`TITLE: ${title}`);
  const when = getVal("dateTime");
  if (when) meta.push(`DATE: ${when}`);
  meta.push(`CALL TYPE: ${callType}`);
  blocks.push(meta.join("\n"));

  const contactLines = [];
  const contact = getVal("contact");
  const contactType = $("contactType").value;
  if (contact) contactLines.push(`CONTACT: ${contact} (${contactType})`);
  else if (contactType) contactLines.push(`CONTACT TYPE: ${contactType}`);
  const phone = getVal("phone");
  if (phone) contactLines.push(`PHONE: ${phone}`);
  const dealer = getVal("dealerName");
  if (dealer && contactType === "Dealer") contactLines.push(`DEALER: ${dealer}`);
  if (contactLines.length) blocks.push(contactLines.join("\n"));

  const envLines = [];
  const deviceType = getVal("deviceType");
  const os = getOsLabel(); const osVer = getVal("osVersion");
  if (deviceType) envLines.push(`- Device Type: ${deviceType}`);
  if (os || osVer) envLines.push(`- OS: ${osLine()}`);
  if (getVal("deviceFirmware")) envLines.push(`- Device Firmware: ${getVal("deviceFirmware")}`);
  if (getVal("deviceToolVersion")) envLines.push(`- Device Tool: ${getVal("deviceToolVersion")}`);
  if (getVal("didapi")) envLines.push(`- DIDAPI: ${getVal("didapi")}`);
  if (getVal("romexis")) envLines.push(`- Romexis: ${getVal("romexis")}`);
  if (getVal("imagingPackage")) envLines.push(`- Imaging Package: ${getVal("imagingPackage")}`);
  if (getVal("recoOs")) envLines.push(`- Reco System OS: ${getVal("recoOs")}`);
  if (getVal("recoPc")) envLines.push(`- Reco PC: ${getVal("recoPc")}`);
  if (getVal("recoFirmware")) envLines.push(`- Reco Firmware: ${getVal("recoFirmware")}`);
  if (getVal("serialNumber")) envLines.push(`- Unit Serial: ${getVal("serialNumber")}`);
  if (envLines.length) blocks.push("ENVIRONMENT:\n" + envLines.join("\n"));

  if (getVal("errorInfo")) blocks.push(`ERROR/LOG INFO:\n${getVal("errorInfo")}`);
  if (getVal("partRec")) blocks.push(`PART RECOMMENDATION:\n${getVal("partRec")}`);
  if (getVal("problem")) blocks.push(`ISSUE:\n${getVal("problem")}`);
  if (getVal("workflow")) blocks.push(`TROUBLESHOOTING:\n${getVal("workflow")}`);
  if (getVal("nextSteps")) blocks.push(`NEXT STEPS:\n${getVal("nextSteps")}`);

  const outcome = getVal("outcome");
  if (outcome) {
    blocks.push(`RESOLUTION STATUS: ${normalizeResolutionStatus($("resStatus").value)}\nRESOLUTION:\n${outcome}`);
  }

  return blocks.join(divider) + "\n_________________________________________________";
}

// Clipboard copies omit the TITLE and DATE meta lines - D365 supplies both
// itself - and the CALL TYPE line, which is our own rotation bookkeeping and
// means nothing in a customer-facing case. All three stay in the saved note,
// so a saved ticket and Import keep them. Only the header block (before the
// first divider) is filtered, so body text that happens to start a line with
// "DATE:" is never touched.
export function noteForClipboard(noteText) {
  const text = noteText || "";
  const idx = text.indexOf(NOTE_DIVIDER);
  const head = (idx === -1 ? text : text.slice(0, idx))
    .split(/\r?\n/)
    .filter((line) => !/^(?:TITLE|DATE|CALL TYPE):/.test(line))
    .join("\n");
  const rest = idx === -1 ? "" : text.slice(idx);
  // If the whole header was meta, drop the now-leading divider too.
  return head ? head + rest : rest.replace(NOTE_DIVIDER, "");
}

/* ---- generator: bullet normalization ------------------------------------ */
// Frontend twin of llm._normalize_bullets: force each "* " bullet onto its own
// line. AI Polish normalizes server-side, but text that is TYPED or IMPORTED
// never passes through polish - this catches those paths (Troubleshooting /
// Next Steps) so "a* b* c" doesn't survive as one jammed line.
function normalizeBullets(text) {
  if (!text || !text.trim()) return "";
  let s = text.replace(/\r\n?/g, "\n").trim();
  if (!s.includes("*")) return s;          // plain prose - leave it be
  s = s.replace(/\s*\*+\s*/g, "\n* ");      // each bullet -> newline + "* "
  return s.replace(/\n{2,}/g, "\n").replace(/^\n+|\n+$/g, "");
}

// Reflow a textarea's bullets in place (no-op when nothing changes).
export function normalizeBulletField(id) {
  const el = $(id);
  if (!el) return;
  const fixed = normalizeBullets(el.value);
  if (fixed !== el.value) el.value = fixed;
}
