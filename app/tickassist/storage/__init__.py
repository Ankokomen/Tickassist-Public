"""Persistence. Settings, lists and macros are JSON files in the data folder
(settings.json, lists.json, macros.json); tickets and their photos are kept
in memory for as long as the program runs.

A copy with the dev package opens that package's store instead. Either way
the rest of the program sees the same Store.
"""

import itertools
import os
from dataclasses import dataclass

from .errors import ListItemExistsError, MacroExistsError  # noqa: F401
from .lists import JsonLists
from .macros import JsonMacros
from .settings import JsonSettings
from .sqlite import MemoryDatabase
from .tickets import TicketStore


@dataclass
class Store:
    settings: object          # raw backend: load() / save() / delete()
    lists: object
    macros: object
    tickets: TicketStore
    identity: str             # the path a second launch compares to spot this instance


_memory_names = itertools.count(1)


def _settings_path(data_dir):
    return os.path.join(data_dir, "settings.json")


def open_json(data_dir):
    os.makedirs(data_dir, exist_ok=True)
    db = MemoryDatabase("tickassist_%d_%d" % (os.getpid(), next(_memory_names)))
    settings_path = _settings_path(data_dir)
    return Store(settings=JsonSettings(settings_path),
                 lists=JsonLists(os.path.join(data_dir, "lists.json")),
                 macros=JsonMacros(os.path.join(data_dir, "macros.json")),
                 tickets=TicketStore(db), identity=settings_path)


def open_store(config):
    if config.dev:
        from ..dev import store
        return store.open_store(config.data_dir)
    return open_json(config.data_dir)


def open_settings_only(config):
    """Just the settings backend - for helpers that run beside a live server."""
    if config.dev:
        from ..dev import store
        return store.open_settings(config.data_dir)
    return JsonSettings(_settings_path(config.data_dir))
