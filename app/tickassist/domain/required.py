"""Required-field rules: "Device Type is hardware -> Serial Number, OS Version"
blocks Save until those fields are filled. The page evaluates them; the
server only checks what it is asked to store."""

import json

FIELD_IDS = {"serialNumber", "osVersion", "deviceFirmware", "deviceToolVersion",
             "deviceType", "recoPc", "contact", "phone", "dealerName", "problem"}
KINDS = {"always", "hardware", "software", "device", "contact"}
DURING = {"", "First Impressions", "Troubleshooting"}
MAX_RULES = 30


def clean_rules(raw):
    """Validate the rules; return them as compact JSON text."""
    try:
        rules = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        raise ValueError("The required-field rules are not valid.")
    if not isinstance(rules, list) or len(rules) > MAX_RULES:
        raise ValueError("The required-field rules are not valid.")
    clean = []
    for r in rules:
        if not isinstance(r, dict) or r.get("kind") not in KINDS:
            raise ValueError("A required-field rule has an unknown condition.")
        fields = [f for f in (r.get("fields") or []) if f in FIELD_IDS]
        during = r.get("during") or ""
        if during not in DURING:
            raise ValueError("A required-field rule has an unknown call type.")
        clean.append({"kind": r["kind"], "value": str(r.get("value") or "").strip()[:80],
                      "fields": list(dict.fromkeys(fields)), "during": during})
    return json.dumps(clean, separators=(",", ":"))
