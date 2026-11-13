"""Phone numbers, case numbers and call-page addresses found in MAX's text."""

import re
from urllib.parse import parse_qs

# NANP numbers: area code and exchange both start 2-9, which keeps timestamps,
# durations, and most IDs out. Separators are optional.
_PHONE_RE = re.compile(
    r"(?<!\d)(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?([2-9]\d{2})[\s.\-]?(\d{4})(?!\d)"
)

# A D365 case number shown with the call - e.g. "Inbound Case Reference:
# CAS0490097" in the Call Triage panel MAX pops. That panel can load when the
# call is answered rather than when it rings, so it is looked for longer than
# the skill; the CAS + 7 digits shape is distinctive enough to allow that.
CASE_SECONDS = 120
CASE_RE = re.compile(r"(?<![A-Za-z0-9])CAS-?(\d{7})(?!\d)", re.IGNORECASE)

# The page CXone opens when a call is answered carries the call's own id:
#   .../transfer_pop2.html?contactId=...&ani=...&caseNumber=CAS...
# TickAssist reads it from the browser's address bar.
URL_MATCH = r"transfer_pop2[^?\s]*\?"


def digits_of(value):
    return re.sub(r"\D", "", value or "")


def normalize_phone(value):
    """Return the 10-digit NANP number in `value`, or None."""
    d = digits_of(value)
    if len(d) == 11 and d.startswith("1"):
        d = d[1:]
    if len(d) == 10 and d[0] in "23456789" and d[3] in "23456789":
        return d
    return None


def find_phones(text):
    """Every distinct 10-digit phone number in `text`, in order of appearance."""
    found = []
    for m in _PHONE_RE.finditer(text or ""):
        raw = m.group(0)
        # An unbroken run of 11 digits is far more often a CXone contact ID
        # than a number written as 1XXXXXXXXXX; insist on a separator or "+".
        if len(digits_of(raw)) == 11 and raw.isdigit():
            continue
        num = "".join(m.groups())
        if num not in found:
            found.append(num)
    return found


def format_phone(d):
    return f"{d[:3]}-{d[3:6]}-{d[6:]}"

def find_cases(lines):
    """Distinct case numbers in the lines, normalised to CAS0490097."""
    out = []
    for ln in lines:
        for m in CASE_RE.finditer(ln or ""):
            num = "CAS" + m.group(1)
            if num not in out:
                out.append(num)
    return out


def one_case(lines):
    """The case number in the lines, if exactly one distinct number is there."""
    found = find_cases(lines)
    return found[0] if len(found) == 1 else None


def parse_call_url(text):
    """{contact_id, ani, case, name} from a call-page address, or None."""
    m = re.search(r"transfer_pop2[^?\s]*\?(\S+)", text or "")
    if not m:
        return None
    q = parse_qs(m.group(1).replace("&amp;", "&"))

    def one(key):
        return (q.get(key) or [""])[0].strip()
    cid = one("contactId")
    if not re.match(r"^\d{1,32}$", cid):
        return None
    return {"contact_id": cid, "ani": normalize_phone(one("ani")),
            "case": one("caseNumber"), "name": one("contactName")}
