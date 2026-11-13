"""Where this PC's own settings are kept: raw key -> text, no defaults applied.

The layering (built-in < office < this PC) is services/settings.py's job.
"""

from .jsonfile import JsonFile


class JsonSettings:
    """settings.json in the data folder."""

    def __init__(self, path):
        self._file = JsonFile(path, {})
        self.path = path

    def load(self):
        with self._file.locked():
            return {k: str(v) for k, v in self._file.read().items()}

    def save(self, values):
        with self._file.edit() as saved:
            saved.update({k: str(v) for k, v in values.items()})

    def delete(self, keys):
        with self._file.edit() as saved:
            for key in keys:
                saved.pop(key, None)
