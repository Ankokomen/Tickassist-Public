"""The latest incoming call, which the Note Generator long-polls for."""

import threading
import time

from .phones import format_phone


class IncomingCalls:
    """Every route (window reader, browser reader, screen pop, Test) publishes
    here; /api/incoming waits on the sequence number."""

    def __init__(self):
        self._cond = threading.Condition()
        self.seq = 0
        self.event = None
        self.case_enabled = True       # off when "Case number from MAX" is switched off

    def publish(self, num, source, contact_type=None, matched=None, update=False,
                case_number=None, contact_id=None):
        with self._cond:
            self.seq += 1
            self.event = {"seq": self.seq, "phone": format_phone(num),
                          "digits": num, "source": source, "at": time.time(),
                          "contact_type": contact_type, "matched": matched,
                          "case_number": case_number if self.case_enabled else None,
                          # update: same call, its type found a moment later.
                          "update": bool(update),
                          # CXone's id for this call; only a screen pop has it.
                          "contact_id": contact_id}
            self._cond.notify_all()
            return self.event

    def wait(self, since, timeout):
        """Block until there is an event newer than `since` or the timeout."""
        with self._cond:
            if since is not None and self.seq <= since:
                self._cond.wait_for(lambda: self.seq > since, timeout=timeout)
            return self.seq, (self.event if since is not None and self.seq > since
                              else None)
