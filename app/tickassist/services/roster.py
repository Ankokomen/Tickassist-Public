"""The tech roster: a Google Sheet of Tech Name, Phone and Dealer that
TickAssist adds new callers to.

A shared sheet link can only be read, so the writing is done by a small Google
Apps Script that lives in the sheet (SCRIPT below, shown in Settings > Google
Sheets for pasting in). TickAssist sends it the name, phone and dealer; the
script checks for the same name + phone, and if there is none puts the three in
the first empty row. It does the check and the write under a lock, so several
PCs saving at once never double a row. Standard library only.

One number can belong to several people (a front desk, a shared line), and
one person can be typed two ways. So when the pair is missing but the number
is already there under other names, the script says whose it is, and
TickAssist always asks before adding - it never guesses whether "Keith" is a
second person or Keith Miller again.

What protects the sheet is the key: the script only acts for a request that
carries it, and all it will ever do is say whether a name + phone pair is
there (and, if not, the few names that number already has) and add one that
is not. It cannot be made to read the roster out or to change a row. Every
row it adds is written down in the sheet's "TickAssist log" tab, which is the
record to undo from. What is written goes in as plain text, so a name that begins
with "=" is a name, not a formula.
"""

import json
import re
import urllib.error
import urllib.request
from urllib.parse import urlparse

TIMEOUT = 30
# What is sent is cut to this: a name is a name, not a document.
MAX_TEXT = 200
MIN_DIGITS = 7
MODES = ("auto", "ask", "off")
DEFAULT_MODE = "ask"          # a sheet other people rely on is not written to unasked

SCRIPT = """\
// TickAssist tech roster. Paste into the roster sheet: Extensions > Apps Script.
// Then Deploy > New deployment > Web app: Execute as "Me", Who has access "Anyone".
// Put the web app address and the KEY below into TickAssist (Settings > Google Sheets).
const KEY = "CHANGE-ME-to-a-long-random-secret";
const TAB = "";            // the tab to use; "" = the first tab
const HEADER_ROWS = 1;     // rows at the top to leave alone (the headings)
const NAME_COL = 1, PHONE_COL = 2, DEALER_COL = 3;   // A, B, C
const LOG_TAB = "TickAssist log";                    // "" = no log

function norm(s)   { return String(s).toLowerCase().replace(/\\s+/g, " ").trim(); }
function digits(s) { return String(s).replace(/\\D/g, "").slice(-10); }
// Written as text, whatever it starts with: "=..." must not become a formula.
function put(cell, s) { cell.setNumberFormat("@").setValue(String(s).trim().slice(0, 200)); }
function reply(o)  { return ContentService.createTextOutput(JSON.stringify(o))
                       .setMimeType(ContentService.MimeType.JSON); }

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return reply({ok: false, error: "bad request"}); }
  if (req.key !== KEY) return reply({ok: false, error: "wrong key"});
  const name = String(req.name || "").trim(), phone = String(req.phone || "").trim();
  if (!name || digits(phone).length < 7) return reply({ok: false, error: "name and phone needed"});
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return reply({ok: false, error: "the roster is busy, try again"});   // one request at a time
  try {
    const ss = SpreadsheetApp.getActive();
    const sh = TAB ? ss.getSheetByName(TAB) : ss.getSheets()[0];
    if (!sh) return reply({ok: false, error: "tab not found: " + TAB});
    const last = Math.max(sh.getLastRow(), HEADER_ROWS + 1);
    const rows = sh.getRange(HEADER_ROWS + 1, 1, last - HEADER_ROWS, 3).getValues();
    let free = -1;
    const sameNumber = [];     // who else has this number: at most a handful of names
    for (let i = 0; i < rows.length; i++) {
      const n = rows[i][NAME_COL - 1], p = rows[i][PHONE_COL - 1];
      if (norm(n) === norm(name) && digits(p) === digits(phone)) return reply({ok: true, result: "exists"});
      if (free < 0 && String(n).trim() === "" && String(p).trim() === "") free = i;
      if (String(n).trim() !== "" && digits(p) === digits(phone) && sameNumber.length < 5) sameNumber.push(String(n).trim());
    }
    if (req.check_only) return reply({ok: true, result: "missing", same_number: sameNumber});
    const row = HEADER_ROWS + 1 + (free >= 0 ? free : rows.length);
    put(sh.getRange(row, NAME_COL), name);
    put(sh.getRange(row, PHONE_COL), phone);
    put(sh.getRange(row, DEALER_COL), req.dealer || "");
    if (LOG_TAB) {
      const log = ss.getSheetByName(LOG_TAB) || ss.insertSheet(LOG_TAB);
      const at = log.getLastRow() + 1;
      log.getRange(at, 1).setValue(new Date());
      put(log.getRange(at, 2), name); put(log.getRange(at, 3), phone); put(log.getRange(at, 4), req.dealer || "");
      log.getRange(at, 5).setValue(row);
    }
    return reply({ok: true, result: "added", row: row});
  } finally { lock.releaseLock(); }
}
"""


class RosterError(ValueError):
    """A problem the user can act on (no address, wrong key, no network, ...)."""


def digits(text):
    return re.sub(r"\D", "", text or "")


def check_url(value):
    """The Apps Script web app address, or "" for none."""
    url = str(value or "").strip()
    if not url:
        return ""
    p = urlparse(url)
    if p.scheme != "https" or p.hostname != "script.google.com" or "/macros/" not in p.path:
        raise ValueError("The roster address should look like https://script.google.com/macros/s/.../exec")
    return url[:500]


def mode(settings):
    value = (settings.get("roster_mode") or DEFAULT_MODE).strip().lower()
    return value if value in MODES else DEFAULT_MODE


def configured(settings):
    return bool((settings.get("roster_url") or "").strip() and (settings.get("roster_key") or "").strip()
                and mode(settings) != "off")


def usable(name, phone):
    """Only a real name and a phone number worth matching on are sent."""
    return bool((name or "").strip()) and len(digits(phone)) >= MIN_DIGITS


def _call(settings, payload):
    url = (settings.get("roster_url") or "").strip()
    key = (settings.get("roster_key") or "").strip()
    if not url or not key:
        raise RosterError("The tech roster isn't set up yet (Settings > Google Sheets).")
    body = json.dumps(dict(payload, key=key)).encode("utf-8")
    req = urllib.request.Request(check_url(url), data=body, method="POST",
                                 headers={"Content-Type": "text/plain;charset=utf-8",
                                          "User-Agent": "TickAssist-roster"})
    try:
        # Apps Script answers a POST with a redirect to the result.
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read(200000)
    except urllib.error.HTTPError as err:
        raise RosterError("The roster script answered %s. Check it was deployed as a web app that "
                          "\"Anyone\" can run." % err.code)
    except (urllib.error.URLError, OSError) as err:
        raise RosterError("Couldn't reach the roster script (%s)." % getattr(err, "reason", err))
    try:
        answer = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise RosterError("The roster script didn't answer with data. Check the address is the web app "
                          "address (ending /exec) and the deployment lets \"Anyone\" run it.")
    if not answer.get("ok"):
        raise RosterError("The roster script said: %s." % (answer.get("error") or "no"))
    return answer


def check(settings, name, phone):
    """{"result": "exists" | "missing" | "skip"}; with "missing",
    "same_number" lists the names the roster already has for that number."""
    if not usable(name, phone):
        return {"result": "skip"}
    answer = _call(settings, {"name": name.strip()[:MAX_TEXT], "phone": phone.strip()[:MAX_TEXT], "check_only": True})
    out = {"result": answer["result"]}
    if answer["result"] == "missing":
        others = answer.get("same_number")
        out["same_number"] = [str(n)[:MAX_TEXT] for n in others][:5] if isinstance(others, list) else []
    return out


def add(settings, name, phone, dealer=""):
    """"added" (with the row) or "exists"."""
    if not usable(name, phone):
        raise RosterError("A name and a phone number are needed to add to the roster.")
    answer = _call(settings, {"name": name.strip()[:MAX_TEXT], "phone": phone.strip()[:MAX_TEXT],
                              "dealer": (dealer or "").strip()[:MAX_TEXT]})
    return {"result": answer["result"], "row": answer.get("row")}


def test(settings, unsaved=None):
    """Ask the script a question it can only answer if the address and key are right."""
    merged = dict(settings)
    for k in ("roster_url", "roster_key"):
        if unsaved and unsaved.get(k) is not None:
            merged[k] = str(unsaved[k]).strip()
    check_url(merged.get("roster_url"))
    _call(merged, {"name": "TickAssist connection test", "phone": "0000000000", "check_only": True})
    return {"ok": True}
