"""Reading MAX: the PowerShell window reader and the browser reader, feeding
one CallDetector, publishing to IncomingCalls.

MAX runs in a browser, so there is no API to ask for the caller. Two readers:
  * reader.ps1 uses Windows UI Automation - the interface screen readers use -
    to read windows whose title matches the keywords, and Windows toast
    notifications (MAX's "New Contact" toast). No admin rights, nothing to
    install. Windows hides a minimized window's contents from it, and a
    browser only shows it the tab in front.
  * browser.py reads MAX through the debugging port of a browser started with
    "Open MAX", which works minimized or hidden.
"""

import base64
import json
import os
import re
import subprocess
import threading
import time

from .browser import CdpReader
from .detector import CallDetector
from .phones import URL_MATCH, find_phones, format_phone, normalize_phone, one_case, parse_call_url
from .rules import DEFAULT_MATCH, classify, keyword_regex, parse_rules, split_lines

_READER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reader.ps1")


# What PowerShell is started with: a line that loads reader.ps1 and runs it.
# The script itself can't go on the command line - Windows caps that at 32,767
# characters, which an encoded script of this size passes - and running it as
# a file would put it under the PC's script execution policy.
_BOOTSTRAP = "& ([scriptblock]::Create([IO.File]::ReadAllText($env:TA_SCRIPT, [Text.Encoding]::UTF8)))"


class CallWatcher:
    """Runs the PowerShell reader and turns its snapshots into events."""

    SUPPORTED = os.name == "nt"
    INTERVAL_MS = 900

    def __init__(self, calls):
        self.calls = calls
        self.detector = CallDetector()
        self._off_message = "Turned off in Settings."
        self._last_contact_id = None   # the call whose page was last seen for the first time
        self._seen_ids = []            # ...and the ones before it (their pages may still be open)
        self._lock = threading.Lock()
        self._proc_lock = threading.RLock()
        self._cdp = CdpReader()
        self._cdp_lock = threading.Lock()   # one thread in the browser reader at a time
        self._cdp_gen = 0                   # the generation its newest thread runs for
        self._ps_msg = None            # latest snapshots from the two readers
        self._cdp_msg = None
        self._proc = None
        self._thread = None
        self._generation = 0
        self.enabled = False
        self.match = DEFAULT_MATCH
        self.own_profile = ""          # the Open MAX browser's profile folder (Calls sets it)
        self.status = {"state": "off", "message": "", "windows": 0,
                       "last_scan": None}

    # ---- control ---------------------------------------------------------
    def configure(self, enabled, match, ignore, rules=None,
                  off_message="Turned off in Settings."):
        """Apply settings; (re)start or stop the reader as needed."""
        if rules is not None:
            self.detector.set_rules(parse_rules(rules))
        ignore_set = set()
        for part in re.split(r"[,\n;]", ignore or ""):
            num = normalize_phone(part)
            if num:
                ignore_set.add(num)
        self.detector.set_ignore(ignore_set)

        match = match or ""
        changed = (bool(enabled) != self.enabled) or (match != self.match)
        if not enabled:
            self._off_message = off_message
        self.enabled, self.match = bool(enabled), match
        # Saving Settings again after a failure is the natural "try again".
        failed = self.status.get("state") == "error"
        if not changed and not failed and (self._thread or not self.enabled):
            if not self.enabled:
                self._set(state="off", message=self._off_message)
            return
        self.stop()
        if not self.enabled:
            self._set(state="off", message=self._off_message)
            return
        pattern = keyword_regex(match, anchored=True)
        if not self.SUPPORTED:
            self._set(state="unsupported",
                      message="Reading other windows needs Windows; the "
                              "/call?phone= screen-pop route still works.")
            if pattern:
                self._generation += 1
                self._start_cdp(self._generation, pattern)
            return
        self._generation += 1
        if not pattern:
            self._set(state="error", message="Add at least one window keyword.")
            # The browser Open MAX starts is still looked after: it starts off
            # the screen, and this is what brings it on.
            self._start_cdp(self._generation, None)
            return
        self._thread = threading.Thread(target=self._run,
                                        args=(self._generation, pattern),
                                        daemon=True, name="callwatch")
        self._thread.start()
        self._start_cdp(self._generation, pattern)

    def restart(self):
        """Stop the reader and start it again with a clean baseline.

        The Refresh button. Anything already on screen when it comes back up
        is the new baseline, so only a number that appears afterwards counts.
        Returns True if a reader was started.
        """
        if not self.enabled:
            return False
        if not self.SUPPORTED:
            self._set(state="unsupported",
                      message="Reading other windows needs Windows; the "
                              "/call?phone= screen-pop route still works.")
            return False
        pattern = keyword_regex(self.match, anchored=True)
        if not pattern:
            self._set(state="error", message="Add at least one window keyword.")
            return False
        self.stop()
        old = self.detector
        self.detector = CallDetector(ignore=old.ignore, rules=old.rules)
        self._set(state="starting", message="Restarting the window reader...",
                  windows=0, titles=[], scan=[], toasts=0, last_scan=None)
        self._ps_msg = self._cdp_msg = None
        self._generation += 1
        self._thread = threading.Thread(target=self._run,
                                        args=(self._generation, pattern),
                                        daemon=True, name="callwatch")
        self._thread.start()
        self._start_cdp(self._generation, pattern)
        return True

    def stop(self):
        with self._lock:
            self._generation += 1
            proc, self._proc = self._proc, None
            self._thread = None
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass

    # ---- the browser reader (MAX opened with "Open MAX") -------------------
    def _start_cdp(self, gen, pattern):
        title_regex = re.compile(pattern) if pattern else None
        self._cdp_gen = gen
        threading.Thread(target=self._cdp_run, args=(gen, title_regex),
                         daemon=True, name="callwatch-cdp").start()

    def _cdp_run(self, gen, title_regex):
        was = None
        while gen == self._generation:
            # A thread from before a restart may still be in here: they share
            # the browser's connections, so they take turns.
            with self._cdp_lock:
                if gen != self._generation:
                    break
                try:
                    msg = self._cdp.poll(title_regex)
                except Exception:               # never let this thread die quietly
                    msg = {"state": "off", "message": "", "sources": [], "urls": [], "titles": []}
            if gen != self._generation:
                break
            self._cdp_msg = msg
            self._set(browser=msg["state"], browser_message=msg["message"])
            if msg["state"] == "connected" or was == "connected":
                self._process()             # also once when it goes away
            was = msg["state"]
            time.sleep(self.INTERVAL_MS / 1000.0 if msg["state"] == "connected" else 3.0)
        with self._cdp_lock:
            if self._cdp_gen == gen:        # nobody took over: hang up
                self._cdp.close()

    def want_max(self):
        self._cdp.want_max()

    def use_data_dir(self, data_dir):
        """Where the browser reader finds the picture for MAX's window."""
        self._cdp.data_dir = data_dir

    def snapshot_status(self):
        s = dict(self.status)
        s["supported"] = self.SUPPORTED
        s["ambiguous"] = self.detector.last_ambiguous
        s["last_call"] = self.detector.last_call
        return s

    def classify_text(self, text):
        """Contact type for text that came with a screen pop (?skill=)."""
        return classify(self.detector.rules, split_lines(text))

    def note_external(self, num):
        self.detector.note_external(num)

    # ---- internals -------------------------------------------------------
    def _set(self, **kw):
        self.status.update(kw)

    def _spawn(self, pattern):
        encoded = base64.b64encode(_BOOTSTRAP.encode("utf-16-le")).decode("ascii")
        env = dict(os.environ, TA_SCRIPT=_READER, TA_MATCH=pattern, TA_OWN=self.own_profile or "",
                   TA_PARENT=str(os.getpid()),      # the reader ends when this process does
                   TA_TOAST=keyword_regex(self.match),
                   TA_URL=URL_MATCH,
                   TA_INTERVAL_MS=str(self.INTERVAL_MS))
        return subprocess.Popen(
            ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
             "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def _run(self, gen, pattern):
        backoff = 2
        while gen == self._generation:
            self._set(state="starting", message="Starting the window reader...")
            try:
                proc = self._spawn(pattern)
            except OSError as err:
                self._set(state="error", message=f"Could not start PowerShell: {err}")
                return
            with self._lock:
                if gen != self._generation:
                    proc.kill()
                    return
                self._proc = proc
            started = time.time()
            for raw in proc.stdout:
                if gen != self._generation:
                    break
                self._handle_line(raw.decode("utf-8", "replace").strip())
            if gen != self._generation:
                return
            self._ps_msg = None             # what it last saw is no longer what is there
            tail = ""
            try:
                tail = proc.stderr.read().decode("utf-8", "replace").strip()
            except Exception:
                pass
            proc.wait()
            # Constrained Language Mode or a blocked PowerShell fails instantly
            # and every time; say so instead of silently retrying forever.
            msg = tail.splitlines()[-1] if tail else f"exited with code {proc.returncode}"
            self._set(state="error", message=f"Window reader stopped: {msg[:300]}")
            if time.time() - started > 60:
                backoff = 2
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)

    @staticmethod
    def _no_match_message(titles):
        # The fastest way to find MAX's real title is to see the list.
        shown = [t[:60] for t in (titles or []) if t and t != "Program Manager"][:8]
        base = "Running - no window title starts with a keyword yet."
        if shown:
            base += " Open windows: " + "; ".join(f'"{t}"' for t in shown) + "."
        return base

    @staticmethod
    def _scan_hint(items, doc, minimized=False):
        """A plain-English pointer when a window is found but can't be read."""
        if minimized and isinstance(items, int) and items < 15:
            return ("This window is minimized, and Windows hides a minimized "
                    "window's contents from TickAssist. Start MAX with the Open "
                    "MAX button (or the desktop shortcut) and it can be read "
                    "even when minimized.")
        if doc == 0:
            return ("Only the browser frame is readable, not the page itself. In "
                    "Chrome open chrome://accessibility, turn on Native "
                    "accessibility API support, restart Chrome, then press "
                    "Refresh. If MAX runs in a remote desktop or Citrix session "
                    "it cannot be read from this PC.")
        if doc == 1 and isinstance(items, int) and items < 15:
            return ("The page is readable but nearly empty - MAX may still be "
                    "loading or signed out.")
        return None

    def _scan_info(self, sources):
        """What the reader can see right now, for the Settings page."""
        scan = []
        for s in sources:
            if s.get("k") != "window":
                continue
            text = f"{s.get('title') or ''}\n{s.get('text') or ''}"
            nums = [format_phone(n) for n in find_phones(text)
                    if n not in self.detector.ignore]
            items, doc = s.get("n"), s.get("doc")
            scan.append({"title": (s.get("title") or "")[:80], "items": items,
                         "doc": doc, "numbers": nums[:6], "minimized": bool(s.get("min")),
                         "hint": self._scan_hint(items, doc, bool(s.get("min")))})
        return scan[:5]

    def _handle_url(self, url):
        """A call page's address names the call: publish its id once."""
        info = parse_call_url(url)
        if not info:
            return
        # Still on screen: remember the call, so a page opened (or a Transfer
        # drawer used) after the call began can still pick its id up from
        # the status. It is dropped a minute after the page goes away.
        cid = info["contact_id"]
        if cid != self._last_contact_id and cid in self._seen_ids:
            return      # an earlier call's page, left open: not the call, and not news
        self._set(call_page_id=cid, call_page_at=time.time(),
                  call_page_phone=info["ani"] or None)
        if cid == self._last_contact_id:
            return
        self._last_contact_id = cid
        self._seen_ids = (self._seen_ids + [cid])[-50:]
        num = info["ani"]
        if not num and info.get("withheld"):
            # The caller withheld their number: the page still names the call.
            last = self.detector.last_call
            same = bool(last and last.get("withheld") and self.detector.clock() - last.get("at", 0) < 300)
            if not same:
                self.detector.note_external(None)
            self.calls.publish(None, "address-bar", update=same, contact_id=info["contact_id"],
                               case_number=one_case([info["case"]]) if info["case"] else None, withheld=True)
            return
        if not num or num in self.detector.ignore:
            return
        case = one_case([info["case"]]) if info["case"] else None
        last = self.detector.last_call
        # MAX usually reported this caller first: then this only adds the id.
        same = bool(last and last.get("phone") == format_phone(num) and
                    self.detector.clock() - last.get("at", 0) < 300)
        if not same:
            self.detector.note_external(num)
        self.calls.publish(num, "address-bar", update=same, case_number=case,
                           contact_id=info["contact_id"])

    def _handle_line(self, line):
        if not line.startswith("{"):
            return
        try:
            msg = json.loads(line)
        except ValueError:
            return
        if msg.get("t") == "ready":
            self._set(state="running", message="Waiting for a matching window.")
            return
        if msg.get("t") != "snap":
            return
        self._ps_msg = msg
        self._process()

    @staticmethod
    def _listed(value):
        if isinstance(value, dict):     # PowerShell unwraps one-item arrays
            return [value]
        if isinstance(value, str):
            return [value]
        return list(value or [])

    def _process(self):
        """Combine the newest window-reader and browser-reader snapshots."""
        with self._proc_lock:
            ps = self._ps_msg or {}
            web = self._cdp_msg or {}
            msg = dict(ps, t="snap")
            msg["w"] = self._listed(ps.get("w")) + list(web.get("sources") or [])
            msg["all"] = self._listed(ps.get("all")) + list(web.get("titles") or [])
            msg["urls"] = self._listed(ps.get("urls")) + list(web.get("urls") or [])
            if not ps and not web.get("sources") and not web.get("urls"):
                return
            msg["cdp_only"] = not ps
            self._apply(msg)

    def _apply(self, msg):
        sources = msg.get("w") or []
        # Windows of the browser Open MAX started: the window reader only
        # names them, the browser reader is what reads them.
        own = [s for s in sources if s.get("own")]
        sources = [s for s in sources if not s.get("own")]
        windows = [s for s in sources if s.get("k") == "window"]
        self._set(scan=self._scan_info(sources),
                  toasts=len([s for s in sources if s.get("k") == "toast"]))
        # A window that is minimized, or whose page came back empty, has
        # nothing to say this time. It is left out of what the detector is
        # fed, which then remembers what it last showed.
        readable = [s for s in sources if s.get("k") != "window"
                    or (not s.get("min") and (s.get("text") or "").strip())]
        reading = [s for s in readable if s.get("k") == "window"]
        if reading:
            message = f"Reading {len(reading)} matching window{'' if len(reading) == 1 else 's'}."
        elif own and self.status.get("browser") != "connected":
            message = ("MAX is open in the browser Open MAX started, but TickAssist can't reach that browser. "
                       "Close it and press Open MAX again.")
        elif windows and all(s.get("min") for s in windows):
            message = ("MAX is minimized, so Windows hides what it shows. Restore it - or start it with "
                       "Open MAX, which can be read minimized.")
        elif windows:
            message = "The MAX window is there, but nothing in it could be read just now."
        else:
            message = self._no_match_message(msg.get("all"))
        self._set(windows=len(windows), last_scan=time.time(),
                  titles=[s.get("title", "")[:80] for s in windows][:5],
                  scan_ms=msg.get("ms"), toast_ms=msg.get("toast_ms"))
        # The browser reader alone has nothing to say about a window reader
        # that failed: that stays on show.
        if not (msg.get("cdp_only") and self.status.get("state") == "error"):
            self._set(state="running", message=message)
        if msg.get("err"):
            self._set(message=f"Scan problem: {msg['err'][:200]}")
        at = self.status.get("call_page_at")
        if at and time.time() - at > 60:
            self._set(call_page_id=None, call_page_at=None, call_page_phone=None,
                      page_text=None)
        # What MAX shows comes first: it has the skill. The call page's
        # address, read after, then only adds the call's id to that call.
        for ev in self.detector.feed(readable):
            self.calls.publish(ev["phone"], ev["source"], ev.get("contact_type"),
                               ev.get("matched"), ev.get("update", False),
                               ev.get("case_number"), withheld=ev.get("withheld", False))
        urls = msg.get("urls") or []
        if msg.get("bars") is not None and (msg.get("bars") or urls):
            addrs = msg.get("addrs") or []
            if isinstance(addrs, str):
                addrs = [addrs]
            self._set(address_bars=msg.get("bars") or 0,
                      addresses=[str(a)[:110] for a in addrs][:3])
        for url in urls:
            self._handle_url(url)
        # MAX's side panel prints the call page's address as plain text.
        for s in windows:
            blob = s.get("text") or ""
            if "transfer_pop2" not in blob:
                continue
            line = next((ln for ln in blob.splitlines() if "transfer_pop2" in ln), "")
            self._set(page_text=line[:110])
            self._handle_url(blob)
