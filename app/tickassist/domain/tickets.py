"""What a ticket is: its fields, the two rotations and the resolution statuses."""

# Columns persisted for each saved ticket. The page sends and receives these keys.
TICKET_FIELDS = [
    "case_number", "case_title", "call_type", "contact", "contact_type", "phone",
    "dealer_name", "os_name", "os_version", "os_version2", "device_type", "serial_number",
    "device_firmware", "device_tool_version", "didapi", "romexis",
    "imaging_package", "reco_os", "reco_pc", "reco_firmware", "error_info",
    "part_rec", "problem", "workflow", "next_steps", "res_status", "outcome",
    "note_text",
]

# The two rotations a note can come from. The generator carries a standing
# toggle rather than a per-note dropdown: a tech is on one rotation all day.
FIRST_IMPRESSIONS = "First Impressions"
TROUBLESHOOTING = "Troubleshooting"
CALL_TYPES = [FIRST_IMPRESSIONS, TROUBLESHOOTING]

# Earlier builds stored the singular. Normalised on write and migrated on
# startup so the two never coexist as separate categories.
LEGACY_CALL_TYPES = {"First Impression": FIRST_IMPRESSIONS}

# Canonical resolution statuses in display order (mirrors the page's select).
STATUS_ORDER = [
    "Resolved", "Awaiting Information", "Escalated for Troubleshooting",
    "Escalated to Dealer", "Escalated to IT", "Escalated to After Sales",
    "Escalated to Third Party",
]


def normalize(data):
    """Fold a legacy call-type spelling coming from a stale browser tab."""
    call_type = data.get("call_type")
    if call_type in LEGACY_CALL_TYPES:
        data = dict(data, call_type=LEGACY_CALL_TYPES[call_type])
    return data


def normalize_status(status):
    """Fold legacy / blank statuses into 'Resolved' (matches the page)."""
    s = (status or "").strip()
    if not s or s == "Completed":
        return "Resolved"
    return s


def digits(value):
    return "".join(ch for ch in (value or "") if ch.isdigit())


def same_phone(stored, wanted_digits):
    """Digits-only match, either way round, so 410-498-6464, (410) 498 6464 and
    14104986464 are one number."""
    have = digits(stored)
    # A stored "4" or "x12" is not a number: it would end every caller's.
    return len(have) >= 7 and (have.endswith(wanted_digits) or wanted_digits.endswith(have))
