"""The office build's owner file, app/owner.json.

    {"defaults": {"d365": false, ...},     office default feature switches
     "settings": {"llm_model": ...},       office default settings
     "rev": 3,                             bumped by "push to every PC"
     "patches": ["calls-on"]}              update patches already applied

An update never replaces this file, but may carry an app/owner-patch.json
that is merged in once.
"""

import json
import os

# Settings the owner can ship to every PC. Secrets are left out, except the AI
# key when the owner opts in.
OFFICE_SETTING_KEYS = [
    "call_watch_enabled", "max_url", "max_browser", "call_watch_match", "call_watch_ignore",
    "call_watch_rules", "d365_org_url", "d365_tenant_id", "d365_client_id", "d365_case_type",
    "d365_case_origin", "d365_case_extra", "d365_customer_mode", "d365_note_html",
    "llm_provider", "llm_model", "llm_api_key", "transfer_url", "required_rules",
    "software_devices", "sheet_sources", "update_url", "auto_update", "report_rules",
    "polish_prompt", "lists_off", "roster_url", "roster_key", "roster_mode",
]
REV_SETTING = "office_rev"


def load(path):
    """The owner file as a dict; {} when there is none (not an office build)."""
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save(data, path):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, path)


def office_settings(owner):
    values = owner.get("settings") or {}
    return {k: str(v) for k, v in values.items() if k in OFFICE_SETTING_KEYS and v is not None}


def apply_push(settings, owner, features_setting):
    """When the owner has pushed (bumped "rev"), forget this PC's own feature
    choices and its own copies of the office settings, once. True if it did."""
    try:
        rev = int(owner.get("rev") or 0)
        applied = int(settings.get(REV_SETTING) or 0)
    except (TypeError, ValueError):
        return False
    if rev <= applied:
        return False
    settings.forget([features_setting] + list(office_settings(owner)))
    settings.update({REV_SETTING: str(rev)})
    return True


def merge_patch(path, raw):
    """Merge an update's owner-patch.json into owner.json, once per patch id.
    Applying one bumps "rev" so the new defaults reach PCs that had overridden
    them. No owner.json means no office build: nothing to patch."""
    try:
        patch = json.loads(raw.decode("utf-8-sig"))
        with open(path, encoding="utf-8") as fh:
            owner = json.load(fh)
    except (ValueError, OSError):
        return False
    pid = str(patch.get("id") or "")
    done = owner.get("patches") if isinstance(owner.get("patches"), list) else []
    if not pid or pid in done:
        return False
    for section in ("defaults", "settings"):
        if isinstance(patch.get(section), dict):
            owner.setdefault(section, {}).update(patch[section])
    owner["patches"] = done + [pid]
    try:
        owner["rev"] = int(owner.get("rev") or 0) + 1
    except (TypeError, ValueError):
        owner["rev"] = 1
    save(owner, path)
    return True


def drop_password(path):
    """Copies installed before 6.4 carry a "password" entry nothing reads any
    more; take it out of the file."""
    owner = load(path)
    if "password" not in owner:
        return False
    del owner["password"]
    try:
        save(owner, path)
    except OSError:
        return False
    return True
