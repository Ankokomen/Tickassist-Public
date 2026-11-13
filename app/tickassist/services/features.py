"""Feature switches. A feature that is off is hidden on the page and its routes
are refused.

Who decides, highest first:
  * this PC, once someone saves Settings > Features here (features_off)
  * the office defaults in app/owner.json

The switches set what a copy offers; they are not a lock. Anyone using a copy
can change them for that PC.
"""

# key, label, what it covers. Order is the order shown in Settings.
FEATURES = [
    ("calls", "Incoming calls from MAX",
     "Reads the incoming number from CXone MAX (and the /call screen pop) into Phone Number."),
    ("caller_type", "Contact Type from the MAX skill",
     "Sets Contact Type from the skill MAX shows, e.g. FI-Dealer Support = Dealer."),
    ("known_caller", "Known caller details",
     "Fills Contact Name, Contact Type and Dealer Company for a number with an earlier ticket."),
    ("case_from_max", "Case number from MAX",
     "Puts the Inbound Case Reference from the Call Triage panel into Case ID."),
    ("photos", "Photos",
     "Paste, store, copy and save photos with a ticket."),
    ("d365", "Dynamics 365 integration",
     "Sign in to D365, create cases and send notes. Off: New D365 Case opens the browser form as before."),
    ("sheet", "Google Sheets lookup",
     "Fills fields from rows of shared Google Sheets when an Imaging Package, serial number or other key is entered."),
    ("transfer", "Call transfer",
     "Sends the active call to a troubleshooting queue from the Transfer call panel."),
    ("polish", "AI Polish",
     "Clean up the note text with the configured LLM."),
]

# This PC's override in the settings. "default" = follow owner.json.
SETTING = "features_off"
USE_DEFAULTS = "default"


class Features:
    def __init__(self, owner, extra=()):
        """`extra` adds switches to the built-in ones, in the same form."""
        self.catalog = FEATURES + list(extra)
        self.keys = [k for k, _, _ in self.catalog]
        self.labels = {k: label for k, label, _ in self.catalog}
        defaults = owner.get("defaults") or {}
        self._office_off = {k for k in self.keys if defaults.get(k) is False}

    @staticmethod
    def overridden(settings):
        raw = settings.get(SETTING)
        return raw is not None and raw != USE_DEFAULTS

    def off(self, settings):
        if self.overridden(settings):
            return {k.strip() for k in (settings.get(SETTING) or "").split(",") if k.strip() in self.keys}
        return set(self._office_off)

    def enabled(self, settings, key):
        return key not in self.off(settings)

    def state(self, settings):
        off = self.off(settings)
        return {k: k not in off for k in self.keys}

    def public(self, settings):
        return {
            "features": self.state(settings),
            "list": [{"key": k, "label": label, "description": desc} for k, label, desc in self.catalog],
            "overridden": self.overridden(settings),
        }

    def stored_value(self, settings, wanted=None, reset=False):
        """What Save writes to the features setting: the office defaults again
        (reset), or this PC's switched-off keys after applying `wanted`."""
        if reset:
            return USE_DEFAULTS
        current = self.state(settings)
        current.update({k: bool(v) for k, v in (wanted or {}).items() if k in self.keys})
        return ",".join(k for k in self.keys if current.get(k) is False)
