"""Settings as the program sees them, in three layers:

    built-in defaults  <  office defaults (app/owner.json)  <  this PC's own

A value this PC saved that is just the built-in default (Save writes every
field) does not hide the office's value.
"""

from ..domain.settings import DEFAULTS, RETIRED_DEFAULTS


class Settings:
    def __init__(self, backend, office=None):
        self._backend = backend
        self.office = dict(office or {})

    def all(self):
        saved = self._backend.load()
        settings = dict(DEFAULTS)
        settings.update(self.office)
        for key, value in saved.items():
            if key in self.office and value == DEFAULTS.get(key):
                continue
            settings[key] = value
        return settings

    def get(self, key):
        return self.all().get(key, "")

    def update(self, values):
        """Store the given keys. None means "not provided" - a partial update
        never blanks a value (an empty string is an explicit clear). Keys that
        are not settings are ignored. Returns the settings afterwards."""
        clean = {k: str(v) for k, v in values.items() if k in DEFAULTS and v is not None}
        if clean:
            self._backend.save(clean)
        return self.all()

    def forget(self, keys):
        """Drop this PC's own values, so the office (or built-in) ones apply."""
        self._backend.delete(list(keys))

    def retire_old_defaults(self):
        """A stored value equal to a built-in default that a later version
        replaced was never chosen by anyone: move it to the current default."""
        saved = self._backend.load()
        moved = {k: DEFAULTS[k] for k, olds in RETIRED_DEFAULTS.items() if saved.get(k) in olds}
        if moved:
            self._backend.save(moved)
