"""Every setting TickAssist keeps, with its built-in default.

Values are stored as text; switches are "1" / "0". Only keys listed here can
be written. How the Settings page's values are checked before they get here
lives with the page's API (web/api/settings.py).
"""

import json

DEFAULT_REQUIRED_RULES = json.dumps([
    {"kind": "always", "value": "", "fields": ["contact", "phone", "deviceType"],
     "during": "First Impressions"},
    {"kind": "hardware", "value": "", "fields": ["serialNumber"],
     "during": "First Impressions"},
    {"kind": "hardware", "value": "",
     "fields": ["serialNumber", "osVersion", "deviceFirmware"],
     "during": "Troubleshooting"},
], separators=(",", ":"))

DEFAULTS = {
    # AI Polish (services/llm.py).
    "llm_provider": "gemini",
    "llm_api_key": "",
    "llm_model": "gemini-2.5-flash",
    "polish_prompt": "",          # empty = llm.DEFAULT_PROMPT
    # Incoming calls (services/callwatch). On by default: it only ever fills an
    # empty Phone Number field, so it cannot overwrite a note.
    "call_watch_enabled": "1",
    "call_watch_match": "MAX, niceincontact, CXone, Mpower",
    "call_watch_ignore": "",
    # "text in MAX = Contact Type", one per line (callwatch.parse_rules).
    "call_watch_rules": "Dealer = Dealer\nIT = IT\nSales = Sales\nMilitary = Military\nEnd User = End User",
    "max_url": "https://cxone.niceincontact.com",
    "max_browser": "auto",
    # Where Transfer call POSTs; empty = transfer.DEFAULT_URL.
    "transfer_url": "",
    # Required fields: rules that block Save until named fields are filled,
    # and the device types that count as software.
    "required_rules": DEFAULT_REQUIRED_RULES,
    "software_devices": "Workstation, Server, Romexis",
    # Google Sheets (services/sheets.py). sheet_sources is the JSON list of
    # every sheet; the single-sheet keys are what copies before 4.39 saved.
    "sheet_sources": "",
    "sheet_url": "",
    "sheet_key_column": "Imaging Package",
    "sheet_map": "",
    "sheet_overwrite": "0",
    "sheet_check": "1",           # outline values that differ from the sheet row
    # Tech roster (services/roster.py): the Apps Script web app that adds
    # Tech Name / Phone / Dealer rows to a sheet, its secret, and ask | auto | off.
    "roster_url": "",
    "roster_key": "",
    "roster_mode": "ask",
    # Updates (services/update).
    "update_url": "",             # office file only (PCs could set it before 6.6)
    "update_token": "",           # GitHub access token, for a private repository
    "auto_update": "1",
    # First Impressions: every section open ("1") instead of step by step.
    "fi_open_all": "0",
    # System Environment lists switched off (domain/lists.py), comma separated.
    "lists_off": "",
    # Server-report import rules; empty = serverinfo.DEFAULT_RULES.
    "report_rules": "",
    # Dynamics 365 (services/d365.py). The refresh token never reaches the page.
    "d365_org_url": "https://planmecausprod.crm.dynamics.com",
    "d365_tenant_id": "",
    "d365_client_id": "",
    "d365_refresh_token": "",
    "d365_user": "",
    "d365_case_type": "",
    "d365_case_origin": "",
    "d365_case_extra": "",
    "d365_customer_mode": "account",
    "d365_note_html": "1",
    # Feature switches (services/features.py): this PC's switched-off keys, or
    # "default" to follow the office defaults in app/owner.json.
    "features_off": "default",
    # Last owner "push" this PC has applied.
    "office_rev": "0",
}

# Built-in defaults that a later version replaced. A stored value still equal
# to the old default was never chosen by anyone, so it moves to the new one.
RETIRED_DEFAULTS = {
    # 4.32 shipped one required-fields rule for every call type.
    "required_rules": ['[{"kind":"hardware","value":"","fields":["serialNumber","osVersion","deviceFirmware"]}]'],
    # Romexis is software too.
    "software_devices": ["Workstation, Server"],
}


def flag(value):
    """A stored switch as a bool."""
    return str(value) == "1"
