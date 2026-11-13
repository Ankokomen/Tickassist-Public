"""A JSON document on disk: readable, easy to back up, easy to copy to another PC."""

import json
import os
import threading
import time
from contextlib import contextmanager

# Windows refuses to open or replace a file another program holds for a
# moment (the virus scanner or search indexer reading what was just written).
# That is retried for up to about a second before it counts as a failure.
RETRIES = 10
RETRY_PAUSE = 0.1


def _retrying(action):
    for attempt in range(RETRIES):
        try:
            return action()
        except PermissionError:
            if attempt == RETRIES - 1:
                raise
            time.sleep(RETRY_PAUSE)


class JsonFile:
    def __init__(self, path, empty):
        self.path = path
        self._empty = empty            # {} or []: also the type a valid file holds
        self._lock = threading.RLock()

    def exists(self):
        return os.path.exists(self.path)

    def read(self):
        """The document; empty when there is no file or it isn't valid JSON.
        A file that exists but can't be opened right now raises instead of
        reading as empty - edit() would otherwise write the empty one back."""
        def load():
            with open(self.path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        try:
            data = _retrying(load)
        except (FileNotFoundError, ValueError):
            return type(self._empty)()
        return data if isinstance(data, type(self._empty)) else type(self._empty)()

    def write(self, data):
        """Atomically, so a crash or a full disk never leaves half a file."""
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
        _retrying(lambda: os.replace(tmp, self.path))

    @contextmanager
    def edit(self):
        """Read, change in place, write back - under the lock."""
        with self._lock:
            data = self.read()
            yield data
            self.write(data)

    @contextmanager
    def locked(self):
        with self._lock:
            yield
