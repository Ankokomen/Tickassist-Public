"""Google Sheet lookup for TickAssist.

Reads a Google Sheet that is shared as "anyone with the link can view" (or
published to the web) as CSV, finds the row whose key column (default
"Imaging Package") matches what was typed, and returns that row's cells keyed
by TickAssist field. Standard library only; nothing is written back to Google.
"""

import csv
import io
import json
import re
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse, parse_qs

CACHE_SECONDS = 60
TIMEOUT = 15
ALLOWED_HOSTS = ("docs.google.com",)

# Header text (lowercase, letters and digits only) -> ticket field (DB column).
# Lets a sheet whose headers read "Romexis Ver" or "Device Firmware" map with no
# setup. Anything else is mapped by hand in Settings ("Column = Field").
ALIASES = {
    "dealer": "dealer_name", "dealercompany": "dealer_name", "dealername": "dealer_name",
    "contact": "contact", "contactname": "contact", "contacttype": "contact_type",
    "phone": "phone", "phonenumber": "phone",
    "os": "os_version", "osversion": "os_version", "operatingsystem": "os_version",
    "devicetype": "device_type", "device": "device_type",
    "serial": "serial_number", "serialnumber": "serial_number", "unitserial": "serial_number",
    "firmware": "device_firmware", "devicefirmware": "device_firmware",
    "devicetool": "device_tool_version", "devicetoolver": "device_tool_version",
    "devicetoolversion": "device_tool_version",
    "didapi": "didapi", "didapiver": "didapi", "didapiversion": "didapi",
    "romexis": "romexis", "romexisver": "romexis", "romexisversion": "romexis",
    "recoos": "reco_os", "recosystemos": "reco_os",
    "recopc": "reco_pc", "recounit": "reco_pc",
    "recofirmware": "reco_firmware",
    "errorinfo": "error_info", "error": "error_info",
    "partrec": "part_rec", "partrecommendation": "part_rec",
    "problem": "problem", "workflow": "workflow", "nextsteps": "next_steps",
    "outcome": "outcome", "casetitle": "case_title",
    "imagingpackage": "imaging_package", "package": "imaging_package",
    "casenumber": "case_number",
}
# What a hand-written mapping may point at (the key column itself is excluded).
FIELDS = sorted(set(ALIASES.values()))

# TickAssist fields a sheet can be looked up BY (label shown in Settings), and
# the column header assumed when none is given.
KEY_FIELDS = {
    "imaging_package": ("Imaging Package", "Imaging Package"),
    "serial_number": ("Serial Number", "Serial Number"),
    "device_type": ("Device Type", "Device Type"),
    "case_number": ("Case ID", "Case Number"),
    "phone": ("Phone", "Phone"),
    "dealer_name": ("Dealer", "Dealer"),
    "contact": ("Contact", "Contact"),
}
MAX_SOURCES = 12

# The first sheet a fresh copy starts with (until the sheets are edited in Settings).
DEFAULT_SOURCE = {
    "name": "Imaging Package",
    "url": "https://docs.google.com/spreadsheets/d/1ZpEuyuc5rol-EF4p0uBfCko5W9C581sB6JpuhgWKJgI/edit?gid=128700618#gid=128700618",
    "key_field": "imaging_package",
    "key_column": "Imaging Package",
    "map": ("Didapi = didapi\nDevice Tool = device_tool\nPromax = device_firmware\n"
            "Reco = reco_firmware\nProOne = device_firmware\nViso = device_firmware"),
    "overwrite": False,
}

_cache = {}  # export url -> (fetched_at, rows)
_lock = threading.Lock()


class SheetError(ValueError):
    """A problem the user can act on (bad link, sheet not shared, ...)."""


def clean_sources(items):
    """Validate the sheet list from Settings; returns the list to store."""
    if not isinstance(items, list):
        raise ValueError("The sheet list must be a list.")
    out = []
    for raw in items[:MAX_SOURCES]:
        if not isinstance(raw, dict):
            continue
        field = str(raw.get("key_field") or "imaging_package")
        if field not in KEY_FIELDS:
            raise ValueError("Unknown lookup field: %s." % field)
        url = str(raw.get("url") or "").strip()
        name = str(raw.get("name") or "").strip()[:60]
        if not url and not name:
            continue
        out.append({
            "name": name or KEY_FIELDS[field][0] + " sheet",
            "url": url[:2000],
            "key_field": field,
            "key_column": str(raw.get("key_column") or "").strip()[:80] or KEY_FIELDS[field][1],
            "map": str(raw.get("map") or "")[:4000],
            "overwrite": bool(raw.get("overwrite")),
        })
    return out


def sources(settings):
    """The configured sheets. A copy that only has the old single-sheet
    settings still works: it is read as one Imaging Package sheet."""
    raw = (settings.get("sheet_sources") or "").strip()
    items = None
    if raw:
        try:
            items = json.loads(raw)
        except ValueError:
            items = None
    if items is None:
        url = (settings.get("sheet_url") or "").strip()
        if not url:
            return [dict(DEFAULT_SOURCE)] if not raw else []
        items = [{"name": "Imaging Package sheet", "url": url, "key_field": "imaging_package",
                  "key_column": settings.get("sheet_key_column") or "Imaging Package",
                  "map": settings.get("sheet_map") or "",
                  "overwrite": str(settings.get("sheet_overwrite", "0")) == "1"}]
    try:
        return clean_sources(items)
    except ValueError:
        return []


def norm(text):
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def export_url(url):
    """Turn whatever link was pasted into a CSV download link."""
    url = (url or "").strip()
    if not url:
        raise SheetError("No Google Sheet link is set. Paste it in Settings > Integrations > Google Sheet.")
    parts = urlparse(url)
    if parts.scheme != "https" or parts.hostname not in ALLOWED_HOSTS:
        raise SheetError("That doesn't look like a Google Sheets link "
                         "(it should start with https://docs.google.com/spreadsheets/).")
    query = parse_qs(parts.query)
    frag = parse_qs(parts.fragment)
    # Published to the web: /spreadsheets/d/e/<token>/pub...
    match = re.match(r"^/spreadsheets/d/e/([A-Za-z0-9_-]+)", parts.path)
    if match:
        out = f"https://docs.google.com/spreadsheets/d/e/{match.group(1)}/pub?output=csv"
        gid = (query.get("gid") or [""])[0]
        return out + (f"&gid={gid}&single=true" if gid else "")
    match = re.match(r"^/spreadsheets/d/([A-Za-z0-9_-]+)", parts.path)
    if not match:
        raise SheetError("Couldn't find the sheet's id in that link.")
    gid = (query.get("gid") or frag.get("gid") or [""])[0]
    out = f"https://docs.google.com/spreadsheets/d/{match.group(1)}/export?format=csv"
    return out + (f"&gid={gid}" if gid else "")


def fetch_rows(url, fresh=False):
    """The sheet as a list of rows (lists of strings), cached briefly."""
    target = export_url(url)
    now = time.time()
    with _lock:
        hit = _cache.get(target)
        if hit and not fresh and now - hit[0] < CACHE_SECONDS:
            return hit[1]
    req = urllib.request.Request(target, headers={"User-Agent": "TickAssist"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read(20 * 1024 * 1024)
            ctype = resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as err:
        if err.code in (401, 403, 404):
            raise SheetError("Google wouldn't let TickAssist read that sheet. Share it as "
                             "'Anyone with the link can view' (or File > Share > Publish to web).")
        raise SheetError(f"Google returned an error ({err.code}) reading the sheet.")
    except (urllib.error.URLError, OSError) as err:
        stale = _cache.get(target)
        if stale:  # offline: the last copy beats nothing
            return stale[1]
        raise SheetError(f"Couldn't reach Google Sheets ({getattr(err, 'reason', err)}).")
    text = raw.decode("utf-8-sig", errors="replace")
    if "text/html" in ctype.lower() or text.lstrip().lower().startswith(("<!doctype", "<html")):
        raise SheetError("Google sent a sign-in page instead of the sheet. Share it as "
                         "'Anyone with the link can view' (or publish it to the web).")
    rows = [[c.strip() for c in r] for r in csv.reader(io.StringIO(text))]
    with _lock:
        _cache[target] = (now, rows)
    return rows


def parse_map(text):
    """'Column = field' lines -> {normalised column: db field}. Bad lines are ignored.

    The field may be a label ("Romexis Ver") or a column name ("os_version").
    """
    by_norm = {norm(f): f for f in FIELDS}
    out = {}
    for line in (text or "").splitlines():
        col, sep, field = line.partition("=")
        if not sep:
            continue
        resolved = ALIASES.get(norm(field)) or by_norm.get(norm(field))
        if norm(col) and resolved:
            out[norm(col)] = resolved
    return out


def _find_header(rows, key_column):
    """(header_row_index, key_col_index): the first row containing the key column."""
    want = norm(key_column or "Imaging Package")
    for r_i, row in enumerate(rows[:10]):
        for c_i, cell in enumerate(row):
            if norm(cell) == want:
                return r_i, c_i
    raise SheetError(f"No column called '{key_column or 'Imaging Package'}' in the sheet's "
                     "first rows. Check the key column name in Settings > Integrations > Google Sheet.")


class ColMap(dict):
    """{column index: db field}, remembering each column's header text."""
    names = None


def _mapping(header, key_idx, map_text):
    """{column index: db field} - hand-written lines win, then header-name matches."""
    manual = parse_map(map_text)
    out = ColMap()
    out.names = {}
    for i, name in enumerate(header):
        if i == key_idx or not name:
            continue
        field = manual.get(norm(name)) or ALIASES.get(norm(name))
        if field:
            out[i] = field
            out.names[i] = name
    return out


def _words(text):
    return [w for w in re.split(r"[^a-z0-9]+", (text or "").lower()) if len(w) >= 3]


def _row_values(row, cols, prefer=""):
    """{field: value} for one sheet row.

    When several columns feed the same field - e.g. a Promax and a ProOne
    column both mapped to Device Firmware - the column whose heading shares a
    word with the ticket's Device Type is the one used. With no Device Type,
    or none that matches, such a field is left out rather than guessed.
    """
    names = getattr(cols, "names", None) or {}
    by_field = {}
    for c, f in cols.items():
        by_field.setdefault(f, []).append(c)
    hint = _words(prefer)
    out = {}
    for f, idxs in by_field.items():
        if len(idxs) > 1:
            match = [c for c in idxs if any(w in _words(names.get(c)) for w in hint)]
            if not match:
                continue
            idxs = match
        for c in idxs:
            if c < len(row) and row[c].strip():
                out[f] = row[c].strip()
                break
    return out


def _scan(rows, key_column, map_text):
    """Walk the sheet once and yield (row number, row, section label, columns).

    A sheet can hold several tables in the key column - e.g. Promax imaging
    packages at the top and a "Viso Package" block lower down. A row whose key
    cell is text and whose other cells are empty (or that names a package
    column) starts a new section; if it also carries column names, those
    replace the mapping for the rows below it.
    """
    h_i, k_i = _find_header(rows, key_column)
    header = rows[h_i]
    section = header[k_i]
    cols = _mapping(header, k_i, map_text)
    key_head = norm(header[k_i])
    for r_i in range(h_i + 1, len(rows)):
        row = rows[r_i]
        cell = row[k_i] if k_i < len(row) else ""
        others = [c for i, c in enumerate(row) if i != k_i and c]
        words = norm(cell)
        divider = bool(cell) and (not others or words == key_head
                                  or (words.endswith("package") and not any(ch.isdigit() for ch in cell)))
        if divider:
            section = cell
            if len(others) >= 2:  # it is a header row for the block below
                remap = _mapping(row, k_i, map_text)
                if remap:
                    cols = remap
            yield r_i + 1, row, section, cols, True
        else:
            yield r_i + 1, row, section, cols, False


def _prefer(sections, hint):
    """Index of the match whose section name shares a word with the hint (the
    ticket's Device Type, e.g. 'Viso G7'), else 0 - the first match."""
    words = [w for w in re.split(r"[^a-z0-9]+", (hint or "").lower()) if len(w) >= 3]
    for i, label in enumerate(sections):
        if any(w in label.lower() for w in words):
            return i
    return 0


def field_values(settings, field):
    """Every distinct value the linked sheets hold for a TickAssist field, as
    {normalised value: value as written}. A sheet contributes its key column
    (when keyed by this field) and any column mapped to it. Raises SheetError
    only when no sheet could be read at all."""
    out, readable, tried = {}, 0, 0
    last = None
    for src in sources(settings):
        if not src["url"]:
            continue
        tried += 1
        try:
            rows = fetch_rows(src["url"])
            _, k_i = _find_header(rows, src["key_column"])
            scan = list(_scan(rows, src["key_column"], src["map"]))
        except SheetError as err:
            last = err
            continue
        readable += 1
        for _num, row, _section, cols, divider in scan:
            if divider:
                continue
            cells = []
            if src["key_field"] == field and k_i < len(row):
                cells.append(row[k_i])
            cells += [row[c] for c, f in cols.items() if f == field and c < len(row)]
            for cell in cells:
                cell = (cell or "").strip()
                if not cell:
                    continue
                parts = re.split(r"\s*[/;,]\s*", cell) if field == "os_version" else [cell]
                for part in parts:
                    if part and norm(part):
                        out.setdefault(norm(part), part)
    if tried and not readable and last:
        raise last
    return out


def lookup(url, key_column, map_text, key, prefer=""):
    """Rows for `key`. "values" is the best row; "alternatives" are other rows
    (a number can be in more than one section of the sheet)."""
    key_n = norm(key)
    if not key_n:
        return {"found": False, "values": {}}
    rows = fetch_rows(url)
    _, k_i = _find_header(rows, key_column)
    found = []
    for number, row, section, cols, divider in _scan(rows, key_column, map_text):
        if divider or k_i >= len(row) or norm(row[k_i]) != key_n:
            continue
        values = _row_values(row, cols, prefer)
        found.append({"row": number, "section": section, "values": values})
    if not found:
        return {"found": False, "values": {}}
    best = _prefer([m["section"] for m in found], prefer)
    chosen = found[best]
    return {"found": True, "values": chosen["values"], "row": chosen["row"],
            "section": chosen["section"],
            "alternatives": [m for i, m in enumerate(found) if i != best]}


def test(url, key_column, map_text):
    """What a Test button reports: columns found, how each maps, row count."""
    rows = fetch_rows(url, fresh=True)
    h_i, k_i = _find_header(rows, key_column)
    header = rows[h_i]
    cols = _mapping(header, k_i, map_text)
    sections = {}
    for _, row, section, _c, divider in _scan(rows, key_column, map_text):
        if not divider and k_i < len(row) and row[k_i]:
            sections[section] = sections.get(section, 0) + 1
    return {
        "rows": sum(sections.values()),
        "sections": [{"name": n, "rows": c} for n, c in sections.items()],
        "key_column": header[k_i],
        "mapped": [{"column": header[c], "field": f} for c, f in cols.items()],
        "unmapped": [n for i, n in enumerate(header) if n and i != k_i and i not in cols],
    }


def lookup_everywhere(settings, field, key, prefer=""):
    """Look `key` up in every sheet keyed by `field`. None when no such sheet
    is set up; else the results, one per sheet. SheetError only when every
    sheet failed."""
    mine = [s for s in sources(settings) if s["key_field"] == field and s["url"]]
    if not mine:
        return None
    results, errors = [], []
    for src in mine:
        try:
            r = lookup(src["url"], src["key_column"], src["map"], key, prefer)
        except SheetError as err:
            errors.append("%s: %s" % (src["name"], err))
            results.append({"source": src["name"], "found": False, "values": {}, "error": str(err)})
            continue
        r.update({"source": src["name"], "overwrite": src["overwrite"]})
        results.append(r)
    if errors and len(errors) == len(mine):
        raise SheetError("; ".join(errors))
    return results


def test_with(settings, unsaved=None):
    """test() on the sheet the page shows - its unsaved edits, else what is saved."""
    unsaved = unsaved or {}
    pick = lambda k, d="": unsaved[k] if unsaved.get(k) is not None else settings.get(k, d)
    return test(str(pick("sheet_url")).strip(),
                str(pick("sheet_key_column", "Imaging Package")).strip() or "Imaging Package",
                str(pick("sheet_map")))
