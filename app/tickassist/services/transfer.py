"""Call transfer from TickAssist, ported from the standalone Call Triage page.

The CXone screen pop gives TickAssist the call's ContactID (see /call in
server.py). Transferring is then one POST of the same JSON the old page sent
to its signal.php - contactId, targetSkill, caseNumber, contactName,
equipment - to the built-in address (or one set in Settings). It is made from the server, not the
browser, so there is no cross-origin problem and the address is never guessed.

Nothing here touches the phone system itself: the endpoint does the transfer.
"""

import http.client
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

# Equipment / category -> label and destination queues (name, CXone skill id,
# kind). Order is the order shown. Copied from the Call Triage page.
EQUIPMENT = [
    ("db_migration", "Database Migration", [
        ("Dealer - Database Migration", "35671824", "Dealer"),
        ("Database Migration", "10807219", "Standard")]),
    ("chair_equip", "Dental Chair and Equipment", [
        ("Dealer - Dental Chair and Core", "35671829", "Dealer"),
        ("Dental Chair and Equipment", "8403480", "Standard")]),
    ("imaging_sw", "Imaging Software Support", [
        ("Dealer - Imaging Software", "35671822", "Dealer"),
        ("Imaging Software Support", "10807220", "Standard")]),
    ("tube_head", "Intraoral Tube Head", [
        ("Dealer - Intraoral Tube Head", "35671826", "Dealer"),
        ("Intraoral Tube Head", "10807218", "Standard")]),
    ("promax", "Promax Digital", [
        ("Dealer - Promax", "35671823", "Dealer"),
        ("Promax Digital", "10807214", "Standard")]),
    ("proone", "ProOne", [
        ("Dealer - ProOne", "35671825", "Dealer"),
        ("ProOne", "10807216", "Standard")]),
    ("prosensor", "Prosensor", [
        ("Dealer - Prosensor", "35671827", "Dealer"),
        ("Prosensor", "10596786", "Standard")]),
    ("viso", "Viso", [
        ("Dealer - Viso", "35671830", "Dealer"),
        ("Viso", "10807215", "Standard")]),
    ("cadcam", "CadCam", [
        ("Clinical Support", "8403473", "Support"),
        ("Hardware Support", "8403474", "Support"),
        ("Field Technicians Support", "8403475", "Field Tech")]),
    ("cust_service", "Customer Service", [
        ("Customer Service", "8403483", "Direct")]),
]

# The Call Triage page posts to a relative "signal.php", so from
# https://planmecawiki.com/tools/transfer_pop2.html it is this address. Built
# in, so nobody has to type it; an address saved in Settings overrides it.
DEFAULT_URL = "https://planmecawiki.com/tools/signal.php"
LOG_NAME = "transfer-log.txt"
LOG_LINES = 200

CASE_RE = re.compile(r"^CAS\d{7}$")
MIN_CASE = 450000   # older numbers belong to a retired series


class TransferError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def config():
    """The queue map for the page: [{key, label, queues: [{name, skill, kind}]}]."""
    return [{"key": k, "label": label,
             "queues": [{"name": n, "skill": s, "kind": t} for n, s, t in qs]}
            for k, label, qs in EQUIPMENT]


def find_queue(equipment, skill):
    for key, _label, queues in EQUIPMENT:
        if key == equipment:
            for name, sid, kind in queues:
                if sid == str(skill):
                    return name
    return None


def check_case(value):
    """Return None when the case number is usable, else the reason."""
    val = str(value or "").strip().upper()
    if not CASE_RE.match(val):
        return "Case number must be CAS followed by 7 digits (e.g. CAS0481234)."
    if int(val[3:]) < MIN_CASE:
        return (f"Case number {val} is older than the active series "
                "(CAS0450000 and up). Create a new case.")
    return None


def url_for(settings):
    return (settings.get("transfer_url") or "").strip() or DEFAULT_URL


def check_url(url):
    url = (url or "").strip()
    if not re.match(r"^https?://[^\s]+$", url, re.I):
        raise ValueError("The transfer address should start with http:// or https://")
    return url


def execute(url, data):
    """Validate a transfer request and send it. Returns {queue, case}."""
    url = (url or "").strip()
    if not url:
        raise TransferError("No transfer address is set. Add it under Transfer "
                            "setup in the Transfer panel.", 409)
    contact_id = str(data.get("contactId") or "").strip()
    if not contact_id or contact_id.startswith("{"):
        raise TransferError("No active call ID was captured from MAX. Add "
                            "&contactId={CONTACTID} to the screen-pop address.", 409)
    reason = check_case(data.get("caseNumber"))
    if reason:
        raise TransferError(reason, 400)
    equipment = str(data.get("equipment") or "")
    skill = str(data.get("targetSkill") or "")
    queue = find_queue(equipment, skill)
    if not queue:   # a skill id the map doesn't hold is never sent
        raise TransferError("That queue is not in the transfer list.", 400)

    case = str(data["caseNumber"]).strip().upper()
    payload = {"contactId": contact_id, "targetSkill": skill, "caseNumber": case,
               "contactName": str(data.get("contactName") or "").strip(),
               "equipment": equipment}
    # The old page posted from a browser on planmecawiki.com, so send what a
    # browser there would: its origin, its page as referrer, a browser agent.
    parts = urllib.parse.urlsplit(url)
    origin = f"{parts.scheme}://{parts.netloc}"
    page = (f"{origin}{parts.path.rsplit('/', 1)[0]}/transfer_pop2.html"
            f"?contactId={urllib.parse.quote(contact_id)}")
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "*/*",
                 "Origin": origin, "Referer": page, "User-Agent": BROWSER_AGENT},
        method="POST")
    opener = urllib.request.build_opener(_KeepPost())
    try:
        with opener.open(req, timeout=12) as resp:
            status, final = resp.status, resp.geturl()
            ctype = resp.headers.get("Content-Type", "")
            body = resp.read(4096).decode("utf-8", "replace").strip()
    except urllib.error.HTTPError as err:
        detail = err.read(300).decode("utf-8", "replace").strip()
        raise TransferError(f"The transfer service answered {err.code}: "
                            f"{_squash(detail) or err.reason}", 502)
    except (urllib.error.URLError, OSError, http.client.HTTPException) as err:
        raise TransferError("Could not reach the transfer service "
                            f"({getattr(err, 'reason', err)}).", 502)
    problem = reply_problem(ctype, body)
    if problem:
        hint = ""
        if "/public_html/" in final or "/public_html/" in url:
            hint = (" The address contains /public_html/, which is the server's "
                    "folder, not part of the web address - remove it.")
        raise TransferError(f"{problem} (HTTP {status} from {final}; it said: "
                            f"{_squash(body)[:200] or 'nothing'}).{hint}", 502)
    return {"queue": queue, "case": case, "status": status, "url": final,
            "reply": _squash(body)[:300]}


BROWSER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                 "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0")


class _KeepPost(urllib.request.HTTPRedirectHandler):
    """urllib turns a redirected POST into a GET, which would silently do
    nothing here. Resend the same POST to the new address instead."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if code not in (301, 302, 303, 307, 308):
            return None
        # Not the Host (or length) worked out for the first address: the new
        # request gets its own.
        keep = {k: v for k, v in req.header_items() if k.lower() not in ("host", "content-length")}
        return urllib.request.Request(newurl, data=req.data, headers=keep, method="POST")


def _squash(text):
    return re.sub(r"\s+", " ", text or "").strip()


def reply_problem(ctype, body):
    """Why an HTTP 200 reply still was not the transfer service saying OK, or
    None. A web page means the address is wrong, a login or a block."""
    head = body.lstrip()[:200].lower()
    if "html" in (ctype or "").lower() or head.startswith(("<!doctype", "<html")):
        return "The address answered with a web page, not the transfer service"
    try:
        data = json.loads(body)
    except ValueError:
        return None
    if isinstance(data, dict):
        status = str(data.get("status", "")).lower()
        if (data.get("error") or data.get("success") is False or
                data.get("ok") is False or status in ("error", "fail", "failed")):
            return "The transfer service reported a problem"
    return None


def send(url, data, data_dir):
    """execute(), with one line per attempt in <data>/transfer-log.txt so what
    the service said is still there after the panel is closed."""
    who = "call=%s skill=%s case=%s equip=%s" % (
        data.get("contactId"), data.get("targetSkill"), data.get("caseNumber"), data.get("equipment"))
    try:
        result = execute(url, data)
    except TransferError as err:
        _log(data_dir, "FAILED %s -> %s" % (who, err))
        raise
    _log(data_dir, "SENT %s -> HTTP %s from %s; service said: %s" % (
        who, result.get("status"), result.get("url"), result.get("reply") or "(nothing)"))
    return result


def _log(data_dir, line):
    path = os.path.join(data_dir, LOG_NAME)
    try:
        os.makedirs(data_dir, exist_ok=True)
        try:
            with open(path, encoding="utf-8") as fh:
                lines = fh.read().splitlines()[-(LOG_LINES - 1):]
        except OSError:
            lines = []
        lines.append(time.strftime("%Y-%m-%d %H:%M:%S ") + line)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    except OSError:
        pass
