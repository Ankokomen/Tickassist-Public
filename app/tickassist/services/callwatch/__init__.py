"""Incoming calls from CXone MAX (RingCentral Contact Center).

    phones.py    numbers, case numbers and call-page addresses in text
    rules.py     window keywords and "text in MAX = Contact Type" rules
    detector.py  snapshots -> "this is the new caller" (no Windows calls)
    watcher.py   runs the readers (reader.ps1, browser.py) into the detector
    incoming.py  the latest call, long-polled by the Note Generator

Calls is what the rest of the program uses.
"""

import re

from .browser import launch_max, profile_dir
from .incoming import IncomingCalls
from .phones import normalize_phone, one_case
from .rules import DEFAULT_MATCH, DEFAULT_RULES
from .watcher import CallWatcher

# The made-up number Settings > Test sends (555-01xx is reserved for fiction,
# so it can never be a real caller).
TEST_CALL_DIGITS = "8005550100"


class Calls:
    def __init__(self, data_dir=None):
        self.data_dir = data_dir
        self.incoming = IncomingCalls()
        self.watcher = CallWatcher(self.incoming)
        if data_dir:
            self.watcher.own_profile = profile_dir(data_dir)
            self.watcher.use_data_dir(data_dir)

    def configure(self, settings, features):
        """Apply settings and feature switches. Switched off: no reading MAX at
        all, no caller-type rules, or no case numbers passed on to the page."""
        self.incoming.case_enabled = features.enabled(settings, "case_from_max")
        rules = settings.get("call_watch_rules", DEFAULT_RULES)
        if not features.enabled(settings, "caller_type"):
            rules = ""
        feature_on = features.enabled(settings, "calls")
        self.watcher.configure(
            off_message=("Turned off with the checkbox above." if feature_on else
                         "Switched off in Settings > Features for this PC (or by the office defaults)."),
            enabled=(str(settings.get("call_watch_enabled", "1")) == "1" and feature_on),
            match=settings.get("call_watch_match", DEFAULT_MATCH),
            ignore=settings.get("call_watch_ignore", ""),
            rules=rules,
        )

    def status(self):
        return self.watcher.snapshot_status()

    def open_max(self, url, prefer="auto"):
        """Open MAX in a browser TickAssist can read, and go on to MAX in it
        once signed in - again, if its browser is already open."""
        # Its window starts out of sight only while the reader is running: that
        # is what brings MAX - or the sign-in - on screen.
        result = launch_max(url, self.data_dir, prefer, hidden=self.watcher.enabled)
        if result.get("ok"):
            self.watcher.want_max()
        return result

    def wait(self, since, timeout):
        return self.incoming.wait(since, timeout)

    def refresh(self):
        """Restart the window reader with a clean baseline."""
        return self.watcher.restart()

    def test(self):
        """Publish a made-up call through the normal path. The page recognises
        source "test" and only reports that it arrived."""
        return self.incoming.publish(TEST_CALL_DIGITS, "test")

    def screen_pop(self, phone, skill="", case="", contact_id=""):
        """A call pushed by a CXone Studio POPURL / RUNAPP action. None when
        there is no usable phone number."""
        num = normalize_phone(phone)
        if not num:
            return None
        self.watcher.note_external(num)
        hit = self.watcher.classify_text(skill) if skill else None
        if not self.incoming.case_enabled:
            case = ""
        contact_id = (contact_id or "").strip()[:64]
        if contact_id.startswith("{") or not re.match(r"^[\w-]+$", contact_id):
            contact_id = ""     # an unfilled {CONTACTID} template, or junk
        return self.incoming.publish(num, "screen-pop", hit[0] if hit else None,
                                     hit[1] if hit else None,
                                     case_number=one_case([case]) if case else None,
                                     contact_id=contact_id or None)

    def stop(self):
        self.watcher.stop()
