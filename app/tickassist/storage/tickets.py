"""Saved tickets and their photos, in SQLite."""

import sqlite3

from ..domain.tickets import LEGACY_CALL_TYPES, TICKET_FIELDS, digits, normalize, same_phone
from .sqlite import TICKETS_SCHEMA, add_missing_columns

PHOTO_COLUMNS = "id, ticket_id, name, mime, width, height, size, created_at, d365_sent_at"
_TOO_SHORT = 7            # fewer digits than this identify nobody


class TicketStore:
    def __init__(self, db):
        self.db = db
        with db.session() as conn:
            conn.executescript(TICKETS_SCHEMA)
            add_missing_columns(conn)
            # Fold any legacy call-type spelling into the current one. Cheap,
            # idempotent, and it catches rows written by a stale open tab.
            for old, new in LEGACY_CALL_TYPES.items():
                conn.execute("UPDATE tickets SET call_type = ? WHERE call_type = ?", (new, old))

    @property
    def path(self):
        return self.db.path

    # ---- tickets ------------------------------------------------------------
    def get(self, ticket_id):
        with self.db.session() as conn:
            row = conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        return dict(row) if row else None

    def create(self, data):
        values = self._values(data)
        with self.db.session() as conn:
            cur = conn.execute(
                f"INSERT INTO tickets ({', '.join(TICKET_FIELDS)}) "
                f"VALUES ({', '.join('?' * len(TICKET_FIELDS))})", values)
            ticket_id = cur.lastrowid
        return self.get(ticket_id)

    def update(self, ticket_id, data):
        """Overwrite a ticket in place; None if there is no such ticket."""
        values = self._values(data)
        with self.db.session() as conn:
            cur = conn.execute(
                f"UPDATE tickets SET {', '.join(f + ' = ?' for f in TICKET_FIELDS)} WHERE id = ?",
                values + [ticket_id])
            if cur.rowcount == 0:
                return None
        return self.get(ticket_id)

    def delete(self, ticket_id):
        with self.db.session() as conn:
            return conn.execute("DELETE FROM tickets WHERE id = ?", (ticket_id,)).rowcount > 0

    @staticmethod
    def _values(data):
        data = normalize(data)
        return [data.get(f, "") or "" for f in TICKET_FIELDS]

    # ---- by phone number ----------------------------------------------------
    def _by_phone(self, phone, columns):
        """Rows whose phone matches on digits alone, newest first. Normalising
        in Python keeps it readable; the table is small enough that it is free."""
        want = digits(phone)
        if len(want) < _TOO_SHORT:
            return []
        with self.db.session() as conn:
            rows = conn.execute(
                f"SELECT {columns}, phone, datetime(created_at, 'localtime') AS created_at "
                "FROM tickets WHERE TRIM(COALESCE(phone, '')) <> '' ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows if same_phone(r["phone"], want)]

    def by_phone(self, phone, limit=5):
        """Earlier tickets from this number (the repeat-caller line)."""
        return self._by_phone(phone, "id, case_number, case_title, contact, contact_type, "
                                     "dealer_name, problem")[:limit]

    def caller_card(self, phone, limit=3):
        """What the incoming-call card shows about a number already on file:
        the newest few tickets, and how many there are in all."""
        rows = self._by_phone(phone, "id, case_number, case_title, call_type, contact, "
                                     "contact_type, dealer_name, device_type, serial_number, "
                                     "problem, res_status")
        for r in rows:
            r.pop("phone", None)
        return {"count": len(rows), "tickets": rows[:limit]}

    # ---- photos ---------------------------------------------------------------
    def photos(self, ticket_id=None):
        """A ticket's photos, or the unsaved form's draft set when ticket_id is None."""
        with self.db.session() as conn:
            if ticket_id is None:
                rows = conn.execute(f"SELECT {PHOTO_COLUMNS} FROM photos "
                                    "WHERE ticket_id IS NULL ORDER BY id")
            else:
                rows = conn.execute(f"SELECT {PHOTO_COLUMNS} FROM photos "
                                    "WHERE ticket_id = ? ORDER BY id", (ticket_id,))
            return [dict(r) for r in rows]

    def add_photo(self, ticket_id, name, mime, data, width=None, height=None):
        """The stored photo's details; None if the ticket does not exist."""
        with self.db.session() as conn:
            if ticket_id is not None and not self._exists(conn, ticket_id):
                return None
            cur = conn.execute(
                "INSERT INTO photos (ticket_id, name, mime, width, height, size, data) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (ticket_id, (name or "")[:200], mime, width, height, len(data),
                 sqlite3.Binary(data)))
            row = conn.execute(f"SELECT {PHOTO_COLUMNS} FROM photos WHERE id = ?",
                               (cur.lastrowid,)).fetchone()
        return dict(row)

    def photo(self, photo_id):
        """One photo including its bytes."""
        with self.db.session() as conn:
            row = conn.execute("SELECT * FROM photos WHERE id = ?", (photo_id,)).fetchone()
        return dict(row) if row else None

    def delete_photo(self, photo_id):
        with self.db.session() as conn:
            return conn.execute("DELETE FROM photos WHERE id = ?", (photo_id,)).rowcount > 0

    def claim_drafts(self, ticket_id):
        """Attach the draft set to a ticket that was just saved."""
        with self.db.session() as conn:
            if not self._exists(conn, ticket_id):
                return 0
            return conn.execute("UPDATE photos SET ticket_id = ? WHERE ticket_id IS NULL",
                                (ticket_id,)).rowcount

    def copy_photos(self, from_id, to_id):
        """A ticket saved as a copy gets the original's photos too."""
        with self.db.session() as conn:
            if not self._exists(conn, to_id):
                return 0
            return conn.execute(
                "INSERT INTO photos (ticket_id, name, mime, width, height, size, data) "
                "SELECT ?, name, mime, width, height, size, data FROM photos "
                "WHERE ticket_id = ? ORDER BY id", (to_id, from_id)).rowcount

    def mark_sent(self, photo_ids):
        """Remember which photos went to D365, so they aren't offered twice."""
        with self.db.session() as conn:
            conn.executemany("UPDATE photos SET d365_sent_at = datetime('now') WHERE id = ?",
                             [(pid,) for pid in photo_ids])

    def discard_drafts(self):
        with self.db.session() as conn:
            return conn.execute("DELETE FROM photos WHERE ticket_id IS NULL").rowcount

    @staticmethod
    def _exists(conn, ticket_id):
        return conn.execute("SELECT 1 FROM tickets WHERE id = ?", (ticket_id,)).fetchone() is not None
