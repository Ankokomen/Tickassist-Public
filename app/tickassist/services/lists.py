"""The dropdown lists, with their rules applied: fixed lists can't be edited,
a System Environment value can only join its list if a linked Google Sheet
holds it, and a System Environment list that is switched off takes part in
nothing."""

from ..domain import lists as catalog
from ..storage.errors import ListItemExistsError
from . import sheets


class FixedList(Exception):
    """This list only changes with a TickAssist update (HTTP 403)."""

    def __init__(self):
        super().__init__(catalog.FIXED_MESSAGE)


class NotVerifiable(Exception):
    """The list isn't checked against the sheets (HTTP 404)."""


class Lists:
    def __init__(self, store, settings):
        self.store = store
        self.settings = settings

    def switched_off(self):
        """The System Environment lists that are switched off."""
        return catalog.parse_off(self.settings.get("lists_off"))

    def describe(self, key):
        catalog.check_key(key)
        return {"items": self.store.items(key), "fixed": catalog.is_fixed(key),
                "verified": catalog.is_verified(key), "free": catalog.is_free(key),
                "can_switch_off": catalog.can_switch_off(key), "off": key in self.switched_off()}

    def switch(self, key, on):
        """Switch a System Environment list on or off. Its entries stay as
        they are either way."""
        catalog.check_key(key)
        if not catalog.can_switch_off(key):
            raise ValueError("Only the System Environment lists can be switched off.")
        off = self.switched_off()
        (off.discard if on else off.add)(key)
        self.settings.update({"lists_off": ",".join(sorted(off))})
        return self.describe(key)

    def clear(self, key):
        """Remove every entry of a list; returns how many there were."""
        catalog.check_key(key)
        if catalog.is_fixed(key):
            raise FixedList()
        return self.store.clear(key)

    def add(self, key, name):
        catalog.check_key(key)
        if catalog.is_fixed(key):
            raise FixedList()
        if key in self.switched_off():
            raise ValueError("That list is switched off (Settings > Lists & Macros).")
        if catalog.is_verified(key):
            found, problem = self._sheet_values(key)
            if found is None:
                raise ValueError(problem)
            matched = found.get(sheets.norm(name or ""))
            if not matched:
                raise ValueError("'%s' isn't in any of your linked sheets, so it can't be added. "
                                 "Add it to the sheet first." % (name or "").strip())
            name = matched                  # as the sheet writes it
        return self.store.add(key, name)

    def delete(self, key, item_id):
        catalog.check_key(key)
        if catalog.is_fixed(key):
            raise FixedList()
        return self.store.delete(key, item_id)

    def verify(self, key, value):
        """Is `value` in the linked sheets? {"verified", "checked", ...}"""
        if not catalog.is_verified(key):
            raise NotVerifiable("That list isn't checked against the sheets.")
        if key in self.switched_off():       # its field takes any text
            return {"verified": True, "checked": False, "value": value or ""}
        found, problem = self._sheet_values(key)
        if found is None:
            return {"verified": False, "checked": False, "message": problem}
        hit = found.get(sheets.norm(value))
        return {"verified": bool(hit), "checked": True, "value": hit or ""}

    def import_from_sheets(self):
        """Add every value the sheets hold to its System Environment list.
        {"added": {key: n}, "total": n}; ValueError if nothing could be read."""
        added, problems = {}, []
        off = self.switched_off()
        for key in catalog.ENV_LIST_COLUMNS:
            if not catalog.is_verified(key) or key in off:
                continue
            found, problem = self._sheet_values(key)
            if found is None:
                problems.append(problem)
                continue
            have = {sheets.norm(i["name"]) for i in self.store.items(key)}
            for n, value in found.items():
                if n in have:
                    continue
                try:
                    self.store.add(key, value)
                    added[key] = added.get(key, 0) + 1
                except (ListItemExistsError, ValueError):
                    pass
        if problems and not added:
            raise ValueError(problems[0])
        return {"added": added, "total": sum(added.values())}

    def _sheet_values(self, key):
        """({normalised: value as written}, "") from the sheets, or (None, why)."""
        settings = self.settings.all()
        if not [s for s in sheets.sources(settings) if s["url"]]:
            return None, ("This list only takes values found in your Google Sheets, and none is linked "
                          "yet. Add one in Settings > Integrations > Google Sheets.")
        try:
            return sheets.field_values(settings, catalog.ENV_LIST_COLUMNS[key]), ""
        except sheets.SheetError as err:
            return None, "Couldn't read the sheets to check that value: %s" % err
