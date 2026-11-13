"""The dropdown lists the page offers, and the rules each kind of list follows.

Three kinds:
  * fixed     - the values below ARE the list; only a TickAssist update changes it
  * verified  - System Environment lists: a value can only join if a linked
                Google Sheet holds it
  * free      - anyone can add a value (dealers, Romexis versions)
"""

FIXED_LISTS = {
    "device_types": ["Promax", "ProOne", "ProSensor", "ProX", "Planmeca Intra", "Viso",
                     "Server", "Workstation", "Romexis"],
    "reco_units": ["5810", "3600", "3620", "3630", "3650", "3660", "T2 2250"],
    "reco_os": ["CentOS", "Ubuntu"],
}

# System Environment lists that are NOT checked against the Google Sheets (the
# sheets write them in a way that reads badly in notes): anyone can add a value,
# and a value typed into a note is added on save.
FREE_ENV_LISTS = {"romexis_versions"}

# Every list, with the values a brand-new copy starts with.
MANAGED_LISTS = {
    "dealers": ["Henry Schein", "Patterson Dental", "Benco Dental",
                "Burkhart Dental", "Atlanta Dental"],
    "device_types": FIXED_LISTS["device_types"],
    "reco_units": FIXED_LISTS["reco_units"],
    # System Environment lists: typable dropdowns in the note. They fill from
    # saved tickets the first time (see ENV_LIST_COLUMNS) and from each save.
    "os_versions": ["10", "11", "2016", "2019", "2022", "2025",
                    "Ventura 13", "Sonoma 14", "Sequoia 15", "Tahoe 26"],
    "device_firmware": [], "device_tool_versions": [], "didapi_versions": [],
    "romexis_versions": [], "imaging_packages": [],
    "reco_os": FIXED_LISTS["reco_os"], "reco_firmware": [],
}

# System Environment list -> the ticket column it suggests values for.
ENV_LIST_COLUMNS = {
    "os_versions": "os_version", "device_firmware": "device_firmware",
    "device_tool_versions": "device_tool_version", "didapi_versions": "didapi",
    "romexis_versions": "romexis", "imaging_packages": "imaging_package",
    "reco_os": "reco_os", "reco_firmware": "reco_firmware",
}

FIXED_MESSAGE = "This list is fixed. New entries arrive with a TickAssist update."


class UnknownList(KeyError):
    pass


def check_key(key):
    """The key itself, once known to be a list (it doubles as a table name)."""
    if key not in MANAGED_LISTS:
        raise UnknownList(key)
    return key


def is_fixed(key):
    return key in FIXED_LISTS


def is_verified(key):
    """Values must come from a linked Google Sheet."""
    return key in ENV_LIST_COLUMNS and key not in FIXED_LISTS and key not in FREE_ENV_LISTS


def is_free(key):
    return key in FREE_ENV_LISTS


def editable_lists():
    """Lists a merge or an import may add to."""
    return [k for k in MANAGED_LISTS if not is_fixed(k)]


def clean_name(name):
    name = (name or "").strip()
    if not name:
        raise ValueError("Name cannot be empty.")
    return name
