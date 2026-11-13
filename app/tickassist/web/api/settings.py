"""Settings and feature switches, as the Settings page reads and saves them."""

import json
import os
import re

from ...domain.required import clean_rules
from ...domain.settings import flag
from ...services import llm, serverinfo, sheets, transfer
from ...services.callwatch.browser import DEFAULT_MAX_URL
from ...services.update import check_address
from ..http import HttpError
from ..router import Routes

routes = Routes()


# ---- reading ------------------------------------------------------------------
def page_settings(app):
    """Everything the Settings page shows. The AI key is returned so its field
    can be edited: a single-user tool bound to localhost. The D365 refresh
    token never is."""
    s = app.settings.all()
    return {
        "llm_provider": s["llm_provider"],
        "llm_model": s["llm_model"],
        "llm_api_key": s["llm_api_key"],
        "api_key_set": bool((s["llm_api_key"] or "").strip()),
        "call_watch_enabled": flag(s["call_watch_enabled"]),
        "max_url": (s["max_url"] or "").strip() or DEFAULT_MAX_URL,
        "max_browser": s["max_browser"],
        "call_watch_match": s["call_watch_match"],
        "call_watch_ignore": s["call_watch_ignore"],
        "call_watch_rules": s["call_watch_rules"],
        "transfer_url": transfer.url_for(s),
        "required_rules": s["required_rules"],
        "software_devices": s["software_devices"],
        "sheet_url": s["sheet_url"],
        "sheet_sources": sheets.sources(s),
        "update_url": app.updates.url(),
        "auto_update": flag(s["auto_update"]),
        "report_rules": (s["report_rules"] or "").strip() or serverinfo.DEFAULT_RULES,
        "polish_prompt": (s["polish_prompt"] or "").strip() or llm.DEFAULT_PROMPT.strip(),
        "polish_prompt_default": llm.DEFAULT_PROMPT.strip(),
        "report_targets": [{"field": f, "label": v[0]} for f, v in serverinfo.TARGETS.items()],
        "version": app.updates.current(),
        "sheet_key_column": s["sheet_key_column"],
        "sheet_map": s["sheet_map"],
        "sheet_overwrite": flag(s["sheet_overwrite"]),
        "sheet_check": flag(s["sheet_check"]),
        "call_watch": app.calls.status(),
        "d365_org_url": s["d365_org_url"],
        "d365_tenant_id": s["d365_tenant_id"],
        "d365_client_id": s["d365_client_id"],
        "d365_case_type": s["d365_case_type"],
        "d365_case_origin": s["d365_case_origin"],
        "d365_case_extra": s["d365_case_extra"],
        "d365_customer_mode": s["d365_customer_mode"],
        "d365_note_html": flag(s["d365_note_html"]),
        "d365": app.crm.status(),
        "features": app.features.state(s),
    }


@routes.get("/api/settings")
def get_settings(app, req):
    return page_settings(app)


# ---- saving ---------------------------------------------------------------------
# What the page may send, and how each value is checked and stored. A parser
# returns the text to store, None to ignore the value, or raises ValueError.
def _as_is(v):
    return v


def _strip(v):
    return str(v).strip()


def _flag(v):
    return "1" if v else "0"


def _choice(*options):
    return lambda v: v if v in options else None


def _org_url(v):
    org = str(v).strip().rstrip("/")
    if org and not re.match(r"^https://[A-Za-z0-9.-]+$", org) and not os.environ.get("TA_D365_AUTHORITY"):
        raise ValueError("The D365 URL should look like https://yourorg.crm.dynamics.com")
    return org


def _customer_mode(v):
    if v not in ("account", "contact"):
        raise ValueError("Unknown customer mode.")
    return v


def _transfer_url(v):
    v = str(v).strip()
    return transfer.check_url(v) if v else v


def _software_devices(v):
    return ", ".join(p.strip() for p in re.split(r"[,\n;]", str(v)) if p.strip())[:500]


def _sheet_sources(v):
    return json.dumps(sheets.clean_sources(v), separators=(",", ":"))


def _polish_prompt(v):
    # Saving the default text stores nothing, so later improvements to the
    # default still arrive.
    text = str(v).strip()
    return "" if text == llm.DEFAULT_PROMPT.strip() else text[:6000]


FORM = {
    "llm_provider": _as_is,
    "llm_model": _as_is,
    "llm_api_key": _as_is,
    "polish_prompt": _polish_prompt,
    "call_watch_enabled": _flag,
    "max_url": _as_is,
    "max_browser": _choice("auto", "chrome", "edge"),
    "call_watch_match": _as_is,
    "call_watch_ignore": _as_is,
    "call_watch_rules": _as_is,
    "transfer_url": _transfer_url,
    "required_rules": clean_rules,
    "software_devices": _software_devices,
    "sheet_url": _strip,
    "sheet_key_column": _strip,
    "sheet_map": _as_is,
    "sheet_overwrite": _flag,
    "sheet_sources": _sheet_sources,
    "sheet_check": _flag,
    "update_url": check_address,
    "auto_update": _flag,
    "report_rules": lambda v: str(v)[:4000],
    "d365_org_url": _org_url,
    "d365_tenant_id": _strip,
    "d365_client_id": _strip,
    "d365_case_type": _strip,
    "d365_case_origin": _strip,
    "d365_case_extra": _strip,
    "d365_customer_mode": _customer_mode,
    "d365_note_html": _flag,
}
# A sign-in belongs to one org, tenant and app; changing any of them ends it.
D365_IDENTITY = ("d365_org_url", "d365_tenant_id", "d365_client_id")


def parse_form(data):
    """The values to store from what the page sent; absent or null keys are
    left alone. Every value is checked before anything is written."""
    values = {}
    for key, parse in FORM.items():
        if data.get(key) is None:
            continue
        value = parse(data[key])
        if value is not None:
            values[key] = value
    return values


@routes.post("/api/settings")
def save_settings(app, req):
    data = req.json()
    before = app.settings.all()
    updated = app.settings.update(parse_form(data))
    if any(k in data and (before.get(k) or "") != (updated.get(k) or "") for k in D365_IDENTITY):
        app.crm.sign_out()
    app.configure_calls(updated)
    return {
        "llm_provider": updated.get("llm_provider"),
        "llm_model": updated.get("llm_model"),
        "api_key_set": bool((updated.get("llm_api_key") or "").strip()),
        "call_watch": app.calls.status(),
        "d365": app.crm.status(),
    }


# ---- feature switches ------------------------------------------------------------------
@routes.get("/api/features")
def get_features(app, req):
    result = app.features.public(app.settings.all())
    result["restart_needed"] = app.updates.restart_needed()
    result["running_version"] = app.updates.started_version
    return result


@routes.post("/api/features")
def save_features(app, req):
    """Switch features on or off for this PC, or (reset) back to the office
    defaults. Refused while an update waits for a restart: the page being
    served is not the program that is running."""
    data = req.json()
    if app.updates.restart_needed():
        raise HttpError(409, f"TickAssist was updated to {app.updates.current()} while it was running "
                             f"(still running {app.updates.started_version}). Close the TickAssist window, "
                             "start it again with run.bat, then save the features.")
    settings = app.settings.all()
    if not data.get("reset") and not isinstance(data.get("features"), dict):
        raise ValueError("No feature switches sent.")
    value = app.features.stored_value(settings, data.get("features"), reset=bool(data.get("reset")))
    updated = app.settings.update({"features_off": value})
    app.configure_calls(updated)
    result = app.features.public(updated)
    result["call_watch"] = app.calls.status()
    return result
