/* The Note Generator form as data: fields, the OS boxes, the ticket it saves. */

import { $, getVal, on } from "../core/dom.js";
import { callType } from "./calltype.js";
import { editing } from "./edit-session.js";
import { buildNote } from "./note.js";
import { LISTS } from "../lists/lists.js";
import { photos } from "../photos.js";

// The systems worked on are check boxes (a call can involve several). os_name
// is stored as "Windows, macOS"; a single value reads exactly as before.
export function getOs() {
  return [...document.querySelectorAll('input[name="os"]:checked')].map((c) => c.value).join(", ");
}
// "Windows + macOS" when several, "Windows" when one.
export function getOsLabel() { return getOs().split(", ").filter(Boolean).join(" + "); }
export function setOs(text, fallback = true) {
  const want = String(text || "").split(/\s*[,+]\s*/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const boxes = [...document.querySelectorAll('input[name="os"]')];
  boxes.forEach((c) => { c.checked = want.includes(c.value.toLowerCase()); });
  if (fallback && !boxes.some((c) => c.checked)) boxes[0].checked = true;
  syncOs2();
}
function osChecked() {
  return [...document.querySelectorAll('input[name="os"]:checked')].map((c) => c.value);
}
// With two or more systems ticked the first version box belongs to the first
// one and a second box takes the rest ("Windows 11, macOS Sonoma").
export function syncOs2() {
  const names = osChecked();
  const wrap = $("osVersion2-combo");
  if (!wrap) return;
  const two = names.length >= 2;
  wrap.classList.toggle("hidden", !two);
  const box = $("osVersion2");
  box.placeholder = two ? `${names.slice(1).join(" + ")} version` : "Second system version";
  if ($("osVersion")) $("osVersion").placeholder = two ? `${names[0]} version` : "OS Version (e.g., 11)";
  if (!two && box.value) { box.value = ""; }
  if (LISTS.os_versions.combo) LISTS.os_versions.combo.render();
  if (LISTS.os_versions.combo2) LISTS.os_versions.combo2.render();
}
// "Windows 11" for one system, "Windows 11, macOS Sonoma" for several.
export function osLine() {
  const names = osChecked(), v1 = getVal("osVersion"), v2 = getVal("osVersion2");
  if (!names.length) return v1;
  if (names.length === 1) return `${names[0]} ${v1}`.trim();
  return `${names[0]} ${v1}`.trim() + ", " + `${names.slice(1).join(" + ")} ${v2}`.trim();
}

/* ---- generator: form <-> field map -------------------------------------- */
// Maps DB column name -> form element id (radio handled separately).
export const FIELD_MAP = {
  case_number: "caseNumber", case_title: "caseTitle", contact: "contact",
  contact_type: "contactType", phone: "phone", dealer_name: "dealerName",
  os_version: "osVersion", os_version2: "osVersion2", device_type: "deviceType",
  serial_number: "serialNumber", device_firmware: "deviceFirmware",
  device_tool_version: "deviceToolVersion",
  didapi: "didapi", romexis: "romexis",
  imaging_package: "imagingPackage", reco_os: "recoOs", reco_pc: "recoPc",
  reco_firmware: "recoFirmware",
  error_info: "errorInfo", part_rec: "partRec", problem: "problem",
  workflow: "workflow", next_steps: "nextSteps", res_status: "resStatus",
  outcome: "outcome",
};

export function normalizeResolutionStatus(status) {
  if (!status || status === "Completed") return "Resolved";
  return status;
}

export function collectTicket() {
  const data = {};
  for (const [col, id] of Object.entries(FIELD_MAP)) data[col] = getVal(id);
  data.res_status = normalizeResolutionStatus(data.res_status);
  data.os_name = getOs();
  if (osChecked().length < 2) data.os_version2 = "";
  data.call_type = callType;
  data.note_text = buildNote();
  return data;
}

// True when the generator holds anything a user could lose by overwriting it.
export function isFormDirty() {
  const alwaysSet = new Set(["caseNumber", "contactType", "resStatus"]);
  for (const id of Object.values(FIELD_MAP)) {
    if (!alwaysSet.has(id) && getVal(id)) return true;
  }
  if (!editing && photos.length) return true;
  return getVal("caseNumber") !== "CAS";
}

/* ---- generator: save + clear -------------------------------------------- */
// A real case number has been assigned in D365 - anything but blank / the
// seeded "CAS" placeholder counts.
export function hasCaseNumber() {
  const v = getVal("caseNumber");
  return !!v && v.toUpperCase() !== "CAS";
}

// Which system a version name belongs to ("" when it can't be told).
function osOfVersion(name) {
  const n = String(name).trim().toLowerCase();
  if (/ventura|sonoma|sequoia|tahoe|monterey|big sur|catalina|mojave|macos/.test(n)) return "macOS";
  if (/server|^20(08|12|16|19|22|25)\b/.test(n)) return "Windows Server";
  if (/^(7|8|8\.1|10|11)\b/.test(n) || /windows/.test(n)) return "Windows";
  return "";
}
// The first version box follows the first system ticked; the second follows the rest.
export function osVersionsForChecked(items) {
  const on = osChecked();
  if (!on.length) return items;
  const mine = on.length > 1 ? [on[0]] : on;
  return items.filter((it) => { const o = osOfVersion(it.name); return !o || mine.includes(o); });
}
export function osVersionsForRest(items) {
  const rest = osChecked().slice(1);
  if (!rest.length) return items;
  return items.filter((it) => { const o = osOfVersion(it.name); return !o || rest.includes(o); });
}
