"""Shorthand macros, in macros.json. Triggers are unique ignoring case."""

from ..domain import macros as rules
from .errors import MacroExistsError
from .jsonfile import JsonFile


def duplicate(trigger):
    return MacroExistsError(f"Macro '\\{trigger}' already exists.")


class JsonMacros:
    """macros.json: [{"id": 1, "trigger": "rem", "expansion": "..."}, ...]"""

    def __init__(self, path):
        self._file = JsonFile(path, [])

    def all(self):
        with self._file.locked():
            macros = self._file.read()
        return sorted(({"id": m["id"], "trigger": m["trigger"], "expansion": m["expansion"]}
                       for m in macros), key=lambda m: m["trigger"].lower())

    def add(self, trigger, expansion):
        trigger, expansion = rules.validate(trigger, expansion)
        return self._insert(trigger, expansion)

    def _insert(self, trigger, expansion):
        with self._file.edit() as macros:
            if any(m["trigger"].lower() == trigger.lower() for m in macros):
                raise duplicate(trigger)
            new_id = max([m["id"] for m in macros] + [0]) + 1
            macros.append({"id": new_id, "trigger": trigger, "expansion": expansion})
        return {"id": new_id, "trigger": trigger, "expansion": expansion}

    def delete(self, macro_id):
        with self._file.edit() as macros:
            kept = [m for m in macros if m["id"] != macro_id]
            found = len(kept) != len(macros)
            macros[:] = kept
        return found
