"""Read a "CURRENT SERVER INFO" printout (the PC/server report another Planmeca
tool produces) and turn it into TickAssist field values.

The report is plain text:

    [System & Network]
      Operating System         : Microsoft Windows 11 Enterprise
    [Installed Planmeca Software & Services]
      Romexis                  : v6.4.8.1100.25
      DidapiKit                : v5.27.0

Every "Label : value" line is read, whatever section it is in. Labels are
matched loosely (case, spacing and punctuation ignored), so a slightly
different report from the same program still works. Standard library only.
"""

import re

# The rules the importer starts with, one per line: "Report label = TickAssist
# field". Settings > Server report import shows and edits this text. The
# Operating System line is always read (it ticks the Windows / Windows Server /
# macOS box and fills the version); every other line needs a rule.
DEFAULT_RULES = """Romexis = romexis
DidapiKit = didapi
Serial Number = serial_number
Device Firmware = device_firmware
Device Tool Version = device_tool_version
Reco Unit = reco_pc"""

# field -> (label, kind). version: "v6.4.8 3/21/25" -> "6.4.8"; text: as written;
# append: added to what the box already holds, written "Label: value".
TARGETS = {
    "os_version": ("OS Version", "version"),
    "os_version2": ("OS Version (2nd system)", "version"),
    "device_type": ("Device Type", "text"),
    "serial_number": ("Serial Number", "text"),
    "device_firmware": ("Device Firmware", "version"),
    "device_tool_version": ("Device Tool Ver", "version"),
    "didapi": ("DIDAPI Ver", "version"),
    "romexis": ("Romexis Ver", "version"),
    "imaging_package": ("Imaging Package", "text"),
    "reco_os": ("Reco System OS", "text"),
    "reco_pc": ("Reco Unit", "text"),
    "reco_firmware": ("Reco Firmware", "version"),
    "error_info": ("Error Info", "append"),
    "problem": ("Problem", "append"),
    "workflow": ("Workflow", "append"),
    "next_steps": ("Next Steps", "append"),
    "part_rec": ("Part Recommendation", "append"),
}
FIELD_LABELS = {f: v[0] for f, v in TARGETS.items()}


def _norm(label):
    return re.sub(r"[^a-z0-9]+", "", label.lower())


# Names a rule's right-hand side may use: the field key or its label.
_FIELD_BY_NAME = {}
for _f, (_label, _k) in TARGETS.items():
    _FIELD_BY_NAME[_norm(_f)] = _f
    _FIELD_BY_NAME[_norm(_label)] = _f


def parse_rules(text):
    """[(normalised label, field)] from rule lines; bad lines are skipped.
    Several labels may point at one field; the first one found in the report wins."""
    out = []
    for line in (text or "").splitlines():
        label, sep, field = line.partition("=")
        if not sep or not _norm(label):
            continue
        field = _FIELD_BY_NAME.get(_norm(field.split("|")[0]))
        if field:
            out.append((_norm(label), field))
    return out


# The label starts on something that is not a space, so a long run of blanks
# is gone through once rather than over and over.
_LINE = re.compile(r"^\s*([^\s:\[\]=][^:]*?)\s*:\s*(.*?)\s*$")
_SECTION = re.compile(r"^\s*\[([^\]]+)\]\s*$")


def _version(value):
    """'v6.4.8.1100.25' -> '6.4.8.1100.25'. Anything after the first space
    (a date, a path) is dropped."""
    value = value.strip()
    value = re.sub(r"^[vV](?=\d)", "", value)
    return value.split()[0] if value else ""


def parse_os(value):
    """('Windows' | 'Windows Server' | 'macOS' | None, version text)."""
    v = value or ""
    m = re.search(r"windows\s+server\s+(\d{4})(\s*r2)?", v, re.I)
    if m:
        return "Windows Server", m.group(1) + (" R2" if m.group(2) else "")
    m = re.search(r"windows\s+(\d{1,2}(?:\.\d+)?)\b", v, re.I)
    if m:
        return "Windows", m.group(1)
    if re.search(r"windows", v, re.I):
        return "Windows", ""
    m = re.search(r"mac\s?os(?:\s*x)?\s*(\d+(?:\.\d+)?)?", v, re.I)
    if m:
        return "macOS", m.group(1) or ""
    return None, ""


def parse(text, rules_text=None):
    """{"fields": [...], "os_family": str|None, "ignored": [...], "found": bool}

    Each field row is {"field", "label", "value", "from", "mode", "default"}:
    mode "set" replaces the box, "append" adds to what is already there;
    default says whether the row starts ticked. "ignored" lists the lines no
    rule covered, as {"label", "value", "clean"} (clean = version-style value),
    so the page can offer to map them.
    """
    rules = {}
    for key, field in parse_rules(DEFAULT_RULES if not (rules_text or "").strip() else rules_text):
        rules.setdefault(key, field)
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    rows, ignored, seen = [], [], set()
    os_family = None
    warnings = []
    found = False

    def add(field, value, source, default=True):
        kind = TARGETS[field][1] if field in TARGETS else "text"
        append = kind == "append"
        if not value or (not append and field in seen):
            return
        seen.add(field)
        rows.append({"field": field, "label": FIELD_LABELS.get(field, field), "value": value,
                     "from": source, "mode": "append" if append else "set", "default": default})

    for raw in lines:
        sec = _SECTION.match(raw)
        if sec:
            if re.search(r"server info|system|network|planmeca|storage|license", sec.group(1), re.I):
                found = True
            continue
        if re.match(r"^\s*\[(WARN|ERROR|FAIL)\]", raw, re.I):
            warnings.append(re.sub(r"^\s*\[\w+\]\s*", "", raw).strip())
            continue
        m = _LINE.match(raw)
        if not m:
            continue
        label, value = m.group(1).strip(), m.group(2).strip()
        key = _norm(label)
        if key == "operatingsystem":
            fam, ver = parse_os(value)
            if fam:
                os_family = fam
                if ver:
                    add("os_version", ver, "%s: %s" % (label, value))
                found = True
                continue
        field = rules.get(key)
        if field and value:
            kind = TARGETS[field][1]
            if kind == "version":
                out = _version(value)
            elif kind == "append":
                out = "%s: %s" % (label, value)
            else:
                out = value
            add(field, out, "%s: %s" % (label, value))
            found = True
            continue
        if value and not re.match(r"^CURRENT SERVER INFO", label, re.I):
            ignored.append({"label": label, "value": value, "clean": _version(value)})

    if warnings:
        # The health check's warnings are worth having in the note, but are
        # only added when asked for.
        clean = [re.sub(r"\s*\[WARN[^\]]*\]", "", w).strip() for w in warnings[:6]]
        add("error_info", "Health check: " + "; ".join(w[:200] for w in clean),
            "Health check summary", default=False)
    return {"fields": rows, "os_family": os_family, "ignored": ignored[:60], "found": found,
            "targets": [{"field": f, "label": v[0], "kind": v[1]} for f, v in TARGETS.items()]}
