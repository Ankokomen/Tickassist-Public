"""The managed dropdown lists, in lists.json.

A list store keeps these promises: entries are {"id", "name"}, names are
unique ignoring case, fixed lists always match the program exactly, and a
list that has never been seen starts with its defaults - once: a list that
was emptied stays empty.
"""

from ..domain import lists as catalog
from .errors import ListItemExistsError
from .jsonfile import JsonFile


def _sorted(items):
    return sorted(({"id": i["id"], "name": i["name"]} for i in items),
                  key=lambda i: i["name"].lower())


class JsonLists:
    """lists.json: {"dealers": [{"id": 1, "name": "Henry Schein"}, ...], ...}"""

    def __init__(self, path):
        self._file = JsonFile(path, {})
        with self._file.locked():
            lists = self._file.read()
            changed = not self._file.exists()
            for key, defaults in catalog.MANAGED_LISTS.items():
                if key not in lists:
                    lists[key] = [{"id": i + 1, "name": n} for i, n in enumerate(defaults)]
                    changed = True
            for key, fixed in catalog.FIXED_LISTS.items():
                names = [i["name"] for i in lists.get(key, [])]
                if sorted(n.lower() for n in names) != sorted(f.lower() for f in fixed):
                    lists[key] = [{"id": i + 1, "name": n} for i, n in enumerate(fixed)]
                    changed = True
            if changed:
                self._file.write(lists)

    def items(self, key):
        catalog.check_key(key)
        with self._file.locked():
            return _sorted(self._file.read().get(key, []))

    def add(self, key, name):
        catalog.check_key(key)
        name = catalog.clean_name(name)
        with self._file.edit() as lists:
            items = lists.setdefault(key, [])
            if any(i["name"].lower() == name.lower() for i in items):
                raise ListItemExistsError(f"'{name}' already exists.")
            new_id = max([i["id"] for i in items] + [0]) + 1
            items.append({"id": new_id, "name": name})
        return {"id": new_id, "name": name}

    def delete(self, key, item_id):
        catalog.check_key(key)
        with self._file.edit() as lists:
            items = lists.get(key, [])
            kept = [i for i in items if i["id"] != item_id]
            lists[key] = kept
            return len(kept) != len(items)

    def clear(self, key):
        """Empty a list; returns how many entries it had."""
        catalog.check_key(key)
        with self._file.edit() as lists:
            count = len(lists.get(key, []))
            lists[key] = []
            return count

    def add_missing(self, key, names):
        """Add the names not already listed; duplicates are skipped."""
        for name in names:
            try:
                self.add(key, name)
            except (ValueError, ListItemExistsError):
                pass
