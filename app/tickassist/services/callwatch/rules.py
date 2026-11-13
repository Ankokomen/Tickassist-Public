"""Which windows to read, and which Contact Type the text of a call means."""

import re

from .phones import find_phones

DEFAULT_MATCH = "MAX, niceincontact, CXone, Mpower"

# Caller-type rules: "text in MAX = Contact Type", first match wins. Matched
# against text that appeared with the call (the skill, the queue), never the
# whole window, so a skill in the call history cannot classify a new call.
DEFAULT_RULES = """Dealer = Dealer
IT = IT
Sales = Sales
Military = Military
End User = End User"""


def keyword_regex(keywords, anchored=False):
    """Comma/newline separated keywords -> a case-insensitive whole-word regex.

    anchored=True is for window titles: the keyword must START the title
    (after any "(3) " unread counter). "MAX" anywhere would also catch a
    Dynamics tab titled "Promax 3D MAX - E61 error", and a new number typed
    into that page would then look like a caller. Notification text is
    matched anywhere, since Chrome puts the site name on its second line.
    """
    words = [w.strip() for w in re.split(r"[,\n]", keywords or "") if w.strip()]
    if not words:
        return None
    alt = "(?:" + "|".join(re.escape(w) for w in words) + ")"
    if anchored:
        return r"(?i)^\W*(?:\(\d+\)\s*)?" + alt + r"\b"
    return r"(?i)\b" + alt + r"\b"


def parse_rules(text):
    """'keyword = Contact Type' lines -> [(regex, contact_type, keyword)].

    Case-insensitive, except a keyword written entirely in capitals ("IT")
    matches only in capitals - so it never fires on the word "it". Matches
    whole words, where hyphens count as a break: "FI-Dealer Support" has the
    word "Dealer" in it.
    """
    rules = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        sep = "=" if "=" in line else ("->" if "->" in line else None)
        if not sep:
            continue
        key, value = (part.strip() for part in line.split(sep, 1))
        if not key or not value:
            continue
        flags = 0 if (key.isupper() and any(c.isalpha() for c in key)) else re.IGNORECASE
        rx = re.compile(r"(?<![A-Za-z0-9])" + re.escape(key) + r"(?![A-Za-z0-9])", flags)
        rules.append((rx, value, key))
    return rules


def classify(rules, lines):
    """First rule (in order) that matches any line -> (contact_type, line)."""
    for rx, value, _key in rules:
        for line in lines:
            if rx.search(line):
                return value, line
    return None


def lines_for_call(lines, num, ignore=()):
    """(own, neutral): the lines that can describe the call from `num`.

    A line that names a different phone number is that other call's - in
    practice a row of MAX's contact history ("3174305321FI - Dealer
    Support08:01"), which MAX redraws as a new call arrives, so it turns up
    beside the new number. Reading the skill off such a row typed an FI - IT
    Support call as Dealer, because the Dealer rule comes first. Those lines are
    dropped. `own` names this caller's number (its own row), `neutral` names
    none (a skill label, the Call Triage panel). Numbers on the ignore list -
    your own lines - do not make a line another call's.
    """
    own, neutral = [], []
    for line in lines:
        nums = {n for n in find_phones(line) if n not in ignore}
        if not nums:
            neutral.append(line)
        elif nums == {num}:
            own.append(line)
    return own, neutral


def split_lines(text):
    return [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
