/* ---- generator: import (parse a copied note back into the form) --------- */

import { $ } from "../core/dom.js";
import { showToast } from "../core/ui.js";
import { CALL_TYPES, setCallType } from "./calltype.js";
import { saveFormState } from "./draft.js";
import { revealEnvIfFilled } from "./env-section.js";
import { setOs } from "./fields.js";
import { normalizeBulletField } from "./note.js";
import { autoGenerateTitle, update } from "./preview.js";

// The inverse of buildNote(): recognizes the labeled blocks a service note is
// made of and returns { <form-field-id>: value, osName } for the fields found.
// Tolerant of the two shapes a note ships in - the full saved note (with TITLE
// / DATE meta) and the clipboard copy (which strips those lines).
const OS_NAMES = ["Windows Server", "Windows", "macOS"]; // longest-match first
const IMPORT_FIELD_IDS = [
  "caseNumber", "caseTitle", "dateTime", "contact", "contactType", "phone",
  "dealerName", "osVersion", "osVersion2", "deviceType", "serialNumber", "deviceFirmware",
  "deviceToolVersion", "didapi", "romexis", "imagingPackage", "recoOs", "recoPc",
  "recoFirmware", "errorInfo", "partRec", "problem", "workflow",
  "nextSteps", "resStatus", "outcome",
];
// The case number heads the note, but not always as our own "SERVICE NOTE:"
// line: a note that comes back from D365 (or off the preview panel) can carry
// it as "Case Number: ...", "Case #: ...", or "Technical Note: ...".
const CASE_HEADER_RE =
  /^(?:(SERVICE NOTE)|TECHNICAL NOTE|CASE(?:\s*(?:NUMBER|NUM|NO\.?|ID|#))?)\s*[:#]+\s*(.*)$/i;
// A bare case id ("CAS0485000"). Used for a note whose first line is nothing
// but the number, and to vet the labels above so a line like
// "Case: closed by the dealer" can't be mistaken for one.
const CASE_ID_RE = /^[A-Za-z]{2,4}[-\s]?\d{3,}$/;

// A case number is a short token, so never accept a value that runs on into
// the rest of the note - keep the id at its head instead. This is the backstop
// for a note that arrives without its line breaks (see repairLostLineBreaks).
const CASE_VALUE_MAX = 24;
function tidyCaseNumber(value) {
  if (CASE_ID_RE.test(value)) return value;
  const m = value.match(/^[A-Za-z]{2,4}[-\s]?\d{3,}/);
  if (m) return m[0];
  return value.length <= CASE_VALUE_MAX ? value : "";
}

// The case number `line` carries, or "" when it isn't a case header at all.
// Our own label is trusted as-is; the looser ones must look like an id.
function parseCaseHeader(line) {
  const m = line.match(CASE_HEADER_RE);
  if (!m) return "";
  const value = tidyCaseNumber((m[2] || "").trim());
  if (!value) return "";
  return m[1] || CASE_ID_RE.test(value) ? value : "";
}

/* -- import: rebuild a note that lost its line breaks in D365 ------------- */
// Pasted into a D365 timeline entry, a note can come back as one run-on line.
// Its dividers and labels survive, so the lines can be rebuilt from those.
// A note that kept its breaks is returned untouched: the trigger is a divider
// welded to text, which never happens in a note we wrote.
const INLINE_LABELS =
  "SERVICE NOTE|TITLE|DATE|CALL TYPE|CONTACT TYPE|CONTACT|PHONE|DEALER|" +
  "RESOLUTION STATUS";
const BLOCK_LABELS =
  "ENVIRONMENT|ERROR/LOG INFO|PART RECOMMENDATION|ISSUE|TROUBLESHOOTING|" +
  "NEXT STEPS|RESOLUTION";
const ENV_LABELS = "Device Type|Device Firmware|Device Tool|OS|DIDAPI|Romexis|" +
  "Imaging Package|Reco System OS|Reco PC|Reco Firmware|Unit Serial";

function repairLostLineBreaks(text) {
  // Note the excluded "-": the neighbour must be real text, or every divider
  // would match itself (a dash is also a non-newline character).
  const welded = /[^\n-]-{5,}|-{5,}[^\n-]/.test(text);
  const oneLiner = !text.includes("\n") &&
    new RegExp(`(?:${INLINE_LABELS}|${BLOCK_LABELS}):`, "i").test(text);
  if (!welded && !oneLiner) return text;
  return text
    .replace(/\s*_{5,}\s*/g, "\n")                        // signature rule
    .replace(/\s*(-{5,})\s*/g, "\n$1\n")                  // block dividers
    .replace(new RegExp(`\\s*((?:${INLINE_LABELS}):)\\s*`, "gi"), "\n$1 ")
    .replace(new RegExp(`\\s*(${BLOCK_LABELS}):\\s*`, "gi"), "\n$1:\n")
    .replace(new RegExp(`\\s*(-\\s*(?:${ENV_LABELS}):)\\s*`, "gi"), "\n$1 ")
    .replace(/\n{2,}/g, "\n")
    .replace(/^\n+|\n+$/g, "");
}

// Headers whose value is the (possibly multi-line) remainder of their block.
const MULTILINE_HEADERS = {
  "ERROR/LOG INFO": "errorInfo",
  "PART RECOMMENDATION": "partRec",
  "ISSUE": "problem",
  "TROUBLESHOOTING": "workflow",
  "NEXT STEPS": "nextSteps",
  "RESOLUTION": "outcome",
};

// "John Doe (Dealer)" -> contact + contactType; bare text -> contact only.
function parseContactLine(s, out) {
  const m = s.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (m) { out.contact = m[1].trim(); out.contactType = m[2].trim(); }
  else out.contact = s;
}

// "Windows Server 2019" -> osName "Windows Server", osVersion "2019".
function parseOsLine(s, out) {
  // Older notes: "Windows + macOS: 11" (one version for several systems).
  const plus = s.match(/^((?:Windows Server|Windows|macOS)(?:\s*\+\s*(?:Windows Server|Windows|macOS))+)\s*:?\s*(.*)$/i);
  if (plus) { out.osName = plus[1].split(/\s*\+\s*/).join(", "); out.osVersion = plus[2].trim(); return; }
  // Current notes: "Windows 11, macOS Sonoma" (a version for each).
  const parts = s.split(/\s*,\s*(?=(?:Windows Server|Windows|macOS)\b)/i);
  if (parts.length > 1) {
    const names = [], vers = [];
    parts.forEach((p) => { const one = {}; parseOsLine(p.trim(), one); if (one.osName) names.push(one.osName); vers.push(one.osVersion || ""); });
    out.osName = names.join(", ");
    out.osVersion = vers[0] || "";
    out.osVersion2 = vers.slice(1).filter(Boolean).join(", ");
    return;
  }
  for (const n of OS_NAMES) {
    const low = s.toLowerCase();
    if (low === n.toLowerCase() || low.startsWith(n.toLowerCase() + " ")) {
      out.osName = n;
      out.osVersion = s.slice(n.length).trim();
      return;
    }
  }
  out.osVersion = s; // unknown OS name: keep the version, leave the radio default
}

function parseNoteBlock(block, out) {
  const lines = block.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let m;
    const caseId = parseCaseHeader(line);
    if (caseId) out.caseNumber = caseId;
    else if ((m = line.match(/^TITLE:\s*(.*)$/i))) out.caseTitle = m[1].trim();
    else if ((m = line.match(/^DATE:\s*(.*)$/i))) out.dateTime = m[1].trim();
    else if ((m = line.match(/^CALL TYPE:\s*(.*)$/i))) out.callType = m[1].trim();
    else if ((m = line.match(/^CONTACT:\s*(.*)$/i))) parseContactLine(m[1].trim(), out);
    else if ((m = line.match(/^CONTACT TYPE:\s*(.*)$/i))) out.contactType = m[1].trim();
    else if ((m = line.match(/^PHONE:\s*(.*)$/i))) out.phone = m[1].trim();
    else if ((m = line.match(/^DEALER:\s*(.*)$/i))) out.dealerName = m[1].trim();
    else if ((m = line.match(/^-\s*Device Type:\s*(.*)$/i))) out.deviceType = m[1].trim();
    else if ((m = line.match(/^-\s*Device Firmware:\s*(.*)$/i))) out.deviceFirmware = m[1].trim();
    else if ((m = line.match(/^-\s*Device Tool(?:\s*Ver(?:sion)?)?:\s*(.*)$/i))) out.deviceToolVersion = m[1].trim();
    else if ((m = line.match(/^-\s*OS:\s*(.*)$/i))) parseOsLine(m[1].trim(), out);
    else if ((m = line.match(/^-\s*DIDAPI:\s*(.*)$/i))) out.didapi = m[1].trim();
    else if ((m = line.match(/^-\s*Romexis:\s*(.*)$/i))) out.romexis = m[1].trim();
    else if ((m = line.match(/^-\s*Imaging Package:\s*(.*)$/i))) out.imagingPackage = m[1].trim();
    else if ((m = line.match(/^-\s*Reco (?:System )?OS:\s*(.*)$/i))) out.recoOs = m[1].trim();
    else if ((m = line.match(/^-\s*Reco PC:\s*(.*)$/i))) out.recoPc = m[1].trim();
    else if ((m = line.match(/^-\s*Reco Firmware:\s*(.*)$/i))) out.recoFirmware = m[1].trim();
    else if ((m = line.match(/^-\s*Unit Serial:\s*(.*)$/i))) out.serialNumber = m[1].trim();
    else if ((m = line.match(/^RESOLUTION STATUS:\s*(.*)$/i))) out.resStatus = m[1].trim();
    else if (/^ENVIRONMENT:\s*$/i.test(line)) { /* section header, no value */ }
    else {
      // A bare "HEADER:" line claims the rest of the block as its value.
      const key = MULTILINE_HEADERS[line.replace(/:\s*$/, "").toUpperCase()];
      if (key) {
        out[key] = lines.slice(i + 1).join("\n").trim();
        break;
      }
    }
  }
}

function parseNote(text) {
  const out = {};
  // Rich-text paths deliver non-breaking spaces where the note had plain ones.
  let t = (text || "").replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");
  t = repairLostLineBreaks(t);
  t = t.replace(/\n_{5,}\s*$/, ""); // drop the trailing underscore signature line
  t.split(/\n-{5,}\n/).forEach((block) => parseNoteBlock(block, out));
  // Some copies carry the case number unlabeled on the very first line - take
  // it from there when no header claimed one.
  if (out.caseNumber === undefined) {
    const first = (t.split("\n").find((l) => l.trim()) || "").trim();
    if (CASE_ID_RE.test(first)) out.caseNumber = first;
  }
  return out;
}

// Write the parsed values into the form; returns how many fields were filled.
// Only fields the note actually mentioned are touched - untouched form fields
// keep their current value. Select values are applied only if they're a real
// option, so a stray contact/resolution label can't jam the dropdown.
function applyImport(out) {
  let count = 0;
  for (const id of IMPORT_FIELD_IDS) {
    if (out[id] === undefined) continue;
    const el = $(id);
    if (!el) continue;
    if (el.tagName === "SELECT") {
      if ([...el.options].some((o) => o.value === out[id])) { el.value = out[id]; count++; }
    } else {
      el.value = out[id];
      count++;
    }
  }
  if (out.osName) {
    setOs(out.osName, false); count++;
  }
  // An imported note tags this draft only - an unrecognised value is ignored,
  // and the standing rotation is never moved by pasting someone else's note.
  if (out.callType && CALL_TYPES.includes(out.callType)) {
    setCallType(out.callType, false);
    count++;
  }
  revealEnvIfFilled();
  return count;
}

// Read the copied note straight off the clipboard and fill the form - no
// intermediate dialog. localhost is a secure context, so readText() works;
// if the browser blocks it (or the clipboard holds no note), we say so.
export async function importNote() {
  let text = "";
  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error("no clipboard API");
    text = await navigator.clipboard.readText();
  } catch (e) {
    showToast("Couldn't read the clipboard — copy the note, then allow clipboard access", "red");
    return;
  }
  if (!text || !text.trim()) { showToast("Clipboard is empty — copy a note first", "red"); return; }
  let out, count;
  try {
    out = parseNote(text);
    count = applyImport(out);
  } catch (err) {
    // Never fail silently: an unhandled throw here would leave the button dead.
    showToast(`Couldn't read that note: ${err.message}`, "red");
    return;
  }
  if (!count) {
    showToast("No recognizable fields in the copied note", "red");
    return;
  }
  // Split any inline bullets the source note carried in unbroken.
  normalizeBulletField("workflow");
  normalizeBulletField("nextSteps");
  // No title in the note (the clipboard copy strips it)? Rebuild it from the
  // imported device / problem / serial / status so the preview isn't blank.
  if (out.caseTitle === undefined) autoGenerateTitle();
  update();
  saveFormState();
  showToast(`Imported ${count} field${count === 1 ? "" : "s"} from the clipboard`, "green");
}
