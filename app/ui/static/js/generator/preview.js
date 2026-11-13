/* ---- generator: live preview -------------------------------------------- */

import { $, getVal, hasVal, toggle } from "../core/dom.js";
import { callType } from "./calltype.js";
import { scheduleFormSave } from "./draft.js";
import { renderEnvSummary } from "./env-section.js";
import { renderFiSteps } from "./fi-steps.js";
import { getOsLabel, normalizeResolutionStatus, osLine } from "./fields.js";
import { applyRequiredMarks } from "./required.js";
import { applySheetCheck } from "../integrations/sheets.js";

// Format a US phone number as the user types: digits only -> ###-###-####.
export function formatPhone(value) {
  const d = value.replace(/\D/g, "").slice(0, 15); // E.164 caps at 15 digits
  const local = (n) => {
    if (n.length <= 3) return n;
    if (n.length <= 6) return `${n.slice(0, 3)}-${n.slice(3)}`;
    return `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`;
  };
  if (d.length <= 10) return local(d);
  // 11+ digits: leading digits are the country code, last 10 the local number.
  const cc = d.slice(0, d.length - 10);
  return `+${cc} ${local(d.slice(d.length - 10))}`;
}

export function autoGenerateTitle() {
  const parts = [getVal("deviceType"), getVal("problem"), getVal("serialNumber")]
    .filter(Boolean);
  $("caseTitle").value = parts.join(" - ");
  update();
}

export function update() {
  const type = $("contactType").value;
  toggle("dealerContainer", type !== "Dealer");
  applyRequiredMarks();
  applySheetCheck();
  renderFiSteps();

  $("prev-caseNumber").textContent = $("caseNumber").value || "CAS";
  $("prev-title").textContent = $("caseTitle").value;
  toggle("btn-copy-title", !hasVal($("caseTitle").value));

  // Always shown: the note always carries a rotation, so the preview must too.
  $("disp-callType").textContent = callType;

  const when = $("dateTime").value;
  toggle("disp-date-row", !hasVal(when));
  $("disp-date").textContent = when;

  const contact = $("contact").value;
  toggle("disp-contact-row", !hasVal(contact));
  $("disp-contact").textContent = contact;

  toggle("disp-type-row", !hasVal(type));
  $("disp-type").textContent = type;

  const phone = $("phone").value;
  toggle("disp-phone-row", !hasVal(phone));
  $("disp-phone").textContent = phone;

  const dealer = $("dealerName").value;
  const showDealer = type === "Dealer" && hasVal(dealer);
  toggle("disp-dealer-row", !showDealer);
  $("disp-dealer").textContent = dealer;

  const os = getOsLabel();
  const osVer = $("osVersion").value;
  const deviceType = $("deviceType").value;
  const deviceFw = $("deviceFirmware").value;
  const deviceTool = $("deviceToolVersion").value;
  const didapi = $("didapi").value;
  const romexis = $("romexis").value;
  const imgPkg = $("imagingPackage").value;
  const recoOs = $("recoOs").value;
  const reco = $("recoPc").value;
  const recoFw = $("recoFirmware").value;
  const serial = $("serialNumber").value;
  let hasEnv = false;

  if (hasVal(deviceType)) { toggle("disp-deviceType-row", false); $("disp-deviceType").textContent = deviceType; hasEnv = true; }
  else toggle("disp-deviceType-row", true);

  if (hasVal(osVer) || os) { toggle("disp-os-row", false); $("disp-osVersion").textContent = osLine(); hasEnv = true; }
  else toggle("disp-os-row", true);

  if (hasVal(deviceFw) || hasVal(deviceTool)) { toggle("disp-devicefw-row", false); $("disp-deviceFirmware").textContent = deviceFw || "N/A"; $("disp-deviceToolVersion").textContent = deviceTool || "N/A"; hasEnv = true; }
  else toggle("disp-devicefw-row", true);

  if (hasVal(didapi) || hasVal(romexis)) { toggle("disp-versions-row", false); $("disp-didapi").textContent = didapi || "N/A"; $("disp-romexis").textContent = romexis || "N/A"; hasEnv = true; }
  else toggle("disp-versions-row", true);

  if (hasVal(imgPkg)) { toggle("disp-package-row", false); $("disp-imagingPackage").textContent = imgPkg; hasEnv = true; }
  else toggle("disp-package-row", true);

  if (hasVal(recoOs)) { toggle("disp-recoos-row", false); $("disp-recoOs").textContent = recoOs; hasEnv = true; }
  else toggle("disp-recoos-row", true);

  if (hasVal(reco) || hasVal(serial)) { toggle("disp-reco-row", false); $("disp-recoPc").textContent = reco || "N/A"; $("disp-serialNumber").textContent = serial || "N/A"; hasEnv = true; }
  else toggle("disp-reco-row", true);

  if (hasVal(recoFw)) { toggle("disp-recofw-row", false); $("disp-recoFirmware").textContent = recoFw; hasEnv = true; }
  else toggle("disp-recofw-row", true);

  toggle("env-block", !hasEnv);
  renderEnvSummary();

  const err = $("errorInfo").value;
  toggle("error-block", !hasVal(err)); $("disp-error").textContent = err;

  const part = $("partRec").value;
  toggle("part-block", !hasVal(part)); $("disp-part").textContent = part;

  const problem = $("problem").value;
  toggle("problem-block", !hasVal(problem)); $("disp-problem").textContent = problem;

  const workflow = $("workflow").value;
  toggle("workflow-block", !hasVal(workflow)); $("disp-workflow").textContent = workflow;

  const nextSteps = $("nextSteps").value;
  toggle("nextSteps-block", !hasVal(nextSteps)); $("disp-nextSteps").textContent = nextSteps;

  $("disp-res-status").textContent = normalizeResolutionStatus($("resStatus").value);

  const outcome = $("outcome").value;
  toggle("outcome-block", !hasVal(outcome)); $("disp-outcome").textContent = outcome;

  scheduleFormSave();
}
