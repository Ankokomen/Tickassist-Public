"""SQLite plumbing: the ticket schema, its upgrades, and the database tickets
are kept in.

A fresh connection is opened per operation, which keeps things thread-safe
under the threading HTTP server without any shared-connection locking.
"""

import sqlite3
import threading
from contextlib import contextmanager

TICKETS_SCHEMA = """
CREATE TABLE IF NOT EXISTS tickets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    case_number         TEXT,
    case_title          TEXT,
    call_type           TEXT,
    contact             TEXT,
    contact_type        TEXT,
    phone               TEXT,
    dealer_name         TEXT,
    os_name             TEXT,
    os_version          TEXT,
    os_version2         TEXT,
    device_type         TEXT,
    serial_number       TEXT,
    device_firmware     TEXT,
    device_tool_version TEXT,
    didapi              TEXT,
    romexis             TEXT,
    imaging_package     TEXT,
    reco_os             TEXT,
    reco_pc             TEXT,
    reco_firmware       TEXT,
    error_info          TEXT,
    part_rec            TEXT,
    problem             TEXT,
    workflow            TEXT,
    next_steps          TEXT,
    res_status          TEXT,
    outcome             TEXT,
    note_text           TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Photos for a ticket. ticket_id NULL is the unsaved form's draft set; saving
-- the ticket claims them. Deleting a ticket deletes its photos.
CREATE TABLE IF NOT EXISTS photos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id    INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    name         TEXT NOT NULL DEFAULT '',
    mime         TEXT NOT NULL,
    width        INTEGER,
    height       INTEGER,
    size         INTEGER NOT NULL,
    data         BLOB NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    d365_sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_photos_ticket ON photos(ticket_id);
"""

# Columns added after the first release, applied to older databases on start.
COLUMN_UPGRADES = {
    "tickets": {
        "next_steps": "TEXT", "device_firmware": "TEXT", "device_tool_version": "TEXT",
        "reco_firmware": "TEXT", "call_type": "TEXT", "reco_os": "TEXT", "os_version2": "TEXT",
    },
    "photos": {"d365_sent_at": "TEXT"},
}


def table_columns(conn, table):
    return {r[1] for r in conn.execute("PRAGMA table_info(%s)" % table).fetchall()}


def add_missing_columns(conn):
    for table, columns in COLUMN_UPGRADES.items():
        have = table_columns(conn, table)
        for column, kind in columns.items():
            if column not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")


class Database:
    path = None

    def connect(self):
        raise NotImplementedError

    @contextmanager
    def session(self):
        """One transaction: committed on success, rolled back on error, closed after."""
        conn = self.connect()
        try:
            with conn:
                yield conn
        finally:
            conn.close()


class MemoryDatabase(Database):
    """A database that exists only while this process runs."""

    def __init__(self, name):
        self._uri = "file:%s?mode=memory&cache=shared" % name
        self._turn = threading.RLock()
        # Shared-cache memory databases vanish when their last connection
        # closes; this one is kept open for the life of the process.
        self._anchor = sqlite3.connect(self._uri, uri=True, check_same_thread=False)

    def connect(self):
        conn = sqlite3.connect(self._uri, uri=True, timeout=10, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA read_uncommitted = 1")
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    @contextmanager
    def session(self):
        # Connections to a shared memory database lock each other's tables,
        # and that is refused at once instead of waited for: one at a time.
        with self._turn:
            with super().session() as conn:
                yield conn
