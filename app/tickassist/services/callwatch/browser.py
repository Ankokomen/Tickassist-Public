"""Read MAX through the browser itself, so the window can be minimized or hidden.

Windows empties a minimized window for screen-reader style readers. A browser
started with a local "remote debugging" port can instead be asked for the
page's text directly, whatever the window is doing. This module has:

  * launch_max(): start Chrome or Edge on the MAX address with that port open,
    in its own profile (sign in to MAX there once) and with the flags that stop
    the browser throttling a hidden window;
  * CdpReader: poll the port, list the open tabs, read the text of the MAX tab
    and the address of every tab (the call page's address names the call).
    Signing in leaves you on one of CXone's own pages, with MAX two clicks
    away in its Applications menu: the reader makes those clicks, so Open MAX
    ends in MAX.

Only MAX is meant to be seen. The browser is started with its window off the
screen (a browser with no windows at all - "headless" - could not show MAX
either). Signed in already, the reader starts MAX from that unseen page,
brings MAX's own window on screen and closes the page behind it. Not signed
in, nothing happens there for a few seconds: then the window is brought on
screen to sign in, and the same follows once that is done.

The port listens on 127.0.0.1 only. Standard library only: the few WebSocket
frames needed are in websocket.py.
"""

import json
import os
import re
import shutil
import subprocess
import time
import urllib.request

from .websocket import WebSocket, WsError

PORT = int(os.environ.get("TICKASSIST_CDP_PORT") or 9222)
DEFAULT_MAX_URL = "https://cxone.niceincontact.com"
# A tab is MAX when its address is on one of these hosts or its title starts
# with one of the window keywords.
MAX_HOST = re.compile(r"^https?://[^/]*(niceincontact|nice-incontact|nicecxone|incontact)\.", re.I)

# MAX itself, as opposed to the other CXone pages on the hosts above.
MAX_APP = re.compile(r"^https?://max(?:-[a-z0-9]+)?\.[^/]*(?:niceincontact|nice-incontact|nicecxone)\.", re.I)
# Bringing MAX up is tried this many times in one browser session, then left to you.
OPEN_TRIES = 3
# The page MAX was started from is closed once MAX has been up this long: it
# was only the way in, and MAX runs without it.
CLOSE_LAUNCHER_AFTER = 6.0
# Where a hidden browser's window starts (Windows keeps it there, out of
# sight), and how far off counts as hidden.
HIDDEN_AT = -32000
OFF_SCREEN = -10000
# No MAX this long after the browser came up: it is waiting for a sign-in, so
# its window is brought on screen.
REVEAL_AFTER = 8.0
# Where a window is brought on screen. Only ever where, never how big: MAX
# sizes its own window, and resizes it as its panels fly out - a size given
# from outside breaks that.
SIGN_IN_AT = {"left": 120, "top": 80, "windowState": "normal"}
MAX_AT = {"left": 100, "top": 60, "windowState": "normal"}

# Signing in to CXone ends on one of its own pages, and MAX is started from
# the Applications menu in that page's header. MAX has no address of its own
# that works - opened directly it has no session - so the reader presses what
# you would: the menu, then MAX in it. Answers "opened", "no-max" (signed in,
# but MAX is not in the menu) or "none" (not a signed-in CXone page).
_OPEN_MAX_JS = r"""(function () {
  var menu = document.querySelector('.app-picker-panel');
  if (!menu) return 'none';
  function tile() { return document.querySelector('#select-max'); }
  if (!tile()) menu.click();
  return new Promise(function (done) {
    var waited = 0;
    (function look() {
      var t = tile();
      if (t) { t.click(); done('opened'); return; }
      waited += 100;
      if (waited >= 2500) { done('no-max'); return; }
      setTimeout(look, 100);
    })();
  });
})()"""

BROWSER_FLAGS = [
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check",
    # A minimized or covered window must keep running at full speed.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion",
]

# What the page returns: the visible text of the page and of same-origin
# frames, plus the contents of text boxes (MAX shows the call page's address in one).
_READ_JS = r"""(function () {
  var out = [];
  function walk(d, depth) {
    try {
      if (d.body) out.push(d.body.innerText || '');
      var f = d.querySelectorAll('input,textarea');
      for (var i = 0; i < f.length && i < 60; i++) { if (f[i].value) out.push(String(f[i].value)); }
      if (depth < 3) {
        var fr = d.querySelectorAll('iframe,frame');
        for (var j = 0; j < fr.length && j < 20; j++) {
          try { if (fr[j].contentDocument) walk(fr[j].contentDocument, depth + 1); } catch (e) {}
        }
      }
    } catch (e) {}
  }
  walk(document, 0);
  return out.join('\n').slice(0, 200000);
})()"""


# ---- finding and starting the browser --------------------------------------
def _candidates(which):
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local = os.environ.get("LOCALAPPDATA", "")
    chrome = [os.path.join(pf, r"Google\Chrome\Application\chrome.exe"),
              os.path.join(pf86, r"Google\Chrome\Application\chrome.exe"),
              os.path.join(local, r"Google\Chrome\Application\chrome.exe")]
    edge = [os.path.join(pf86, r"Microsoft\Edge\Application\msedge.exe"),
            os.path.join(pf, r"Microsoft\Edge\Application\msedge.exe")]
    if which == "chrome":
        return [("Chrome", p) for p in chrome]
    if which == "edge":
        return [("Edge", p) for p in edge]
    return [("Chrome", p) for p in chrome] + [("Edge", p) for p in edge]


def find_browser(prefer="auto"):
    """(name, path) of the browser to use, or None."""
    override = os.environ.get("TICKASSIST_BROWSER")
    if override and os.path.exists(override):
        return ("Browser", override)
    for name, path in _candidates((prefer or "auto").lower()):
        if path and os.path.exists(path):
            return (name, path)
    if os.name != "nt":
        for exe in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge"):
            found = shutil.which(exe)
            if found:
                return ("Browser", found)
    return None


def profile_dir(data_dir):
    return os.path.join(data_dir, "max-browser-profile")


def reachable(port=PORT):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/json/version" % port, timeout=1.5) as r:
            return r.status == 200
    except (OSError, ValueError):
        return False


def launch_max(url, data_dir, prefer="auto", port=PORT, hidden=False):
    """Open MAX in a browser TickAssist can read. Returns a result dict.
    hidden=True starts its window off the screen: only for a caller that
    will bring up what should be seen (CdpReader, in the running program)."""
    if reachable(port):
        return {"ok": True, "already": True,
                "message": "The browser for MAX is already open - bringing MAX up in it."}
    found = find_browser(prefer)
    if not found:
        return {"ok": False, "message": "Neither Chrome nor Edge was found on this PC."}
    name, path = found
    prof = profile_dir(data_dir)
    os.makedirs(prof, exist_ok=True)
    args = [path, "--remote-debugging-port=%d" % port, "--user-data-dir=" + prof] + BROWSER_FLAGS
    url = (url or "").strip() or DEFAULT_MAX_URL
    if hidden:
        args.append("--window-position=%d,%d" % (HIDDEN_AT, HIDDEN_AT))
    args.append("--app=" + url)
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    try:
        subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=flags, close_fds=True)
    except OSError as err:
        return {"ok": False, "message": "Could not start %s: %s" % (name, err)}
    if hidden:
        return {"ok": True, "already": False, "browser": name,
                "message": "Starting MAX... If CXone needs you to sign in, its window appears in a moment."}
    return {"ok": True, "already": False, "browser": name,
            "message": "Opened %s. Sign in there if it asks (it remembers you next time); "
                       "MAX then opens by itself." % name}


class _Tab:
    """One open connection to a tab, with numbered requests."""

    def __init__(self, ws_url):
        self.ws = WebSocket(ws_url)
        self.n = 0

    def call(self, method, **params):
        """One request to the tab; its result, or {} if it was refused."""
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        for _ in range(50):                 # skip events until our reply
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                return msg.get("result") or {}
        return {}

    def evaluate(self, expression, gesture=False):
        """The page's answer to a piece of JavaScript (a promise is waited
        for). gesture=True runs it as if you had clicked: a page may only
        open a window on a click."""
        res = self.call("Runtime.evaluate", expression=expression, returnByValue=True,
                        awaitPromise=True, userGesture=bool(gesture)).get("result") or {}
        return res.get("value") if isinstance(res.get("value"), str) else ""

    def window(self):
        """(id, bounds) of the browser window this tab is in."""
        got = self.call("Browser.getWindowForTarget")
        return got.get("windowId"), got.get("bounds") or {}

    def hidden(self):
        bounds = self.window()[1]
        return bounds.get("left", 0) < OFF_SCREEN or bounds.get("top", 0) < OFF_SCREEN

    def show(self, bounds):
        """Bring this tab's window on screen, if it is off it. `bounds` says
        where; the window keeps its size."""
        wid, now = self.window()
        if wid is None or not (now.get("left", 0) < OFF_SCREEN or now.get("top", 0) < OFF_SCREEN):
            return False
        self.call("Browser.setWindowBounds", windowId=wid, bounds=bounds)
        return True



# ---- the reader --------------------------------------------------------------
class CdpReader:
    """Polls the debugging port. snapshot() returns the latest result:

        {"state": "off"|"connected", "message": str, "sources": [...],
         "urls": [tab addresses], "titles": [...]}
    Sources look like the window reader's, so the same detector handles them.
    """

    def __init__(self, port=PORT):
        self.port = port
        self._tabs = {}
        self._open_tries = 0       # how often this browser session was asked for MAX
        self.max_note = ""         # what came of it, while that is news
        self._launcher = None      # the tab MAX was started from, until it is closed
        self._max_since = None     # when MAX was first seen after that
        self._up_since = None      # when this browser session was first seen
        self._placed = set()       # MAX tabs whose window has been looked at
        self._revealed = False     # the sign-in window was brought on screen
        self.clock = time.monotonic

    def _get_json(self, path):
        with urllib.request.urlopen("http://127.0.0.1:%d%s" % (self.port, path), timeout=2.0) as r:
            return json.loads(r.read().decode("utf-8", "replace"))

    def close(self):
        for tab in self._tabs.values():
            tab.ws.close()
        self._tabs = {}

    def poll(self, title_regex=None):
        try:
            targets = self._get_json("/json/list")
        except (OSError, ValueError):
            self.close()
            self._open_tries, self.max_note = 0, ""          # the next browser starts afresh
            self._launcher = self._max_since = self._up_since = None
            self._placed, self._revealed = set(), False
            return {"state": "off", "message": "", "sources": [], "urls": [], "titles": []}
        if self._up_since is None:
            self._up_since = self.clock()
        self._go_to_max(targets if isinstance(targets, list) else [])
        sources, urls, titles, live = [], [], [], set()
        for t in targets if isinstance(targets, list) else []:
            if t.get("type") not in ("page", "iframe"):
                continue
            addr, title, tid = t.get("url") or "", t.get("title") or "", t.get("id")
            if addr:
                urls.append(addr)
            is_max = bool(MAX_HOST.match(addr)) or bool(title_regex and title_regex.match(title))
            if not is_max or not t.get("webSocketDebuggerUrl") or not tid:
                continue
            live.add(tid)
            text = self._read_tab(tid, t["webSocketDebuggerUrl"])
            if text is None:
                continue
            if MAX_APP.match(addr) and tid not in self._placed:
                self._placed.add(tid)           # MAX opened from a hidden page is hidden too
                self._show(tid, MAX_AT)
            titles.append(title)
            sources.append({"k": "window", "id": "cdp:" + tid, "title": title or addr,
                            "text": text, "n": len([ln for ln in text.splitlines() if ln.strip()]),
                            "doc": 1, "cdp": True})
        for tid in [k for k in self._tabs if k not in live]:
            self._tabs.pop(tid).ws.close()
        if any(MAX_APP.match(u) for u in urls):
            self.max_note = ""
            self._close_launcher(urls)
        elif (not self._revealed and self._up_since is not None
              and self.clock() - self._up_since > REVEAL_AFTER):
            # Still no MAX: CXone is waiting for a sign-in (or has no MAX to
            # offer). Either way the window has to be seen now.
            self._revealed = True
            for tid in list(self._tabs):
                if self._show(tid, SIGN_IN_AT) and not self.max_note:
                    self.max_note = "Sign in to CXone in the window that just opened; MAX starts by itself after that."
        if self.max_note:
            msg = self.max_note
        elif sources and not any(MAX_APP.match(u) for u in urls):
            msg = "The browser is open for TickAssist; MAX itself is not open in it yet."
        elif sources:
            msg = "Reading %d MAX tab%s through the browser (works minimized)." % (
                len(sources), "" if len(sources) == 1 else "s")
        else:
            msg = "The browser is open for TickAssist, but no MAX tab is in it yet."
        return {"state": "connected", "message": msg, "sources": sources,
                "urls": urls, "titles": titles}

    def _close_launcher(self, urls):
        """MAX is up: the CXone page it was started from has done its job.
        Only the page TickAssist itself pressed MAX on is ever closed."""
        if not self._launcher:
            return
        if self._max_since is None:
            self._max_since = self.clock()
        if self.clock() - self._max_since < CLOSE_LAUNCHER_AFTER:
            return
        tid, self._launcher, self._max_since = self._launcher, None, None
        old = self._tabs.pop(tid, None)
        if old:
            old.ws.close()
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/json/close/%s" % (self.port, tid), timeout=2.0):
                pass
        except (OSError, ValueError):
            pass                      # closed already, by you

    def _show(self, tid, bounds):
        tab = self._tabs.get(tid)
        try:
            return bool(tab) and tab.show(bounds)
        except (OSError, WsError, ValueError):
            return False

    def want_max(self):
        """Open MAX was pressed: bring MAX up again, even if it was closed."""
        self._open_tries, self.max_note = 0, ""
        self._up_since, self._revealed = None, False

    def _go_to_max(self, targets):
        """Signed in but MAX not open: start it from CXone's Applications
        menu. Once MAX is there - or this was tried a few times - the browser
        session is left alone, so MAX closed on purpose stays closed."""
        if self._open_tries >= OPEN_TRIES:
            return
        pages = [t for t in targets if t.get("type") == "page"]
        if any(MAX_APP.match(t.get("url") or "") for t in pages):
            self._open_tries = OPEN_TRIES
            return
        for t in pages:
            if not MAX_HOST.match(t.get("url") or "") or not t.get("webSocketDebuggerUrl") or not t.get("id"):
                continue
            try:
                tab = self._tabs.get(t["id"])
                if tab is None:
                    tab = self._tabs[t["id"]] = _Tab(t["webSocketDebuggerUrl"])
                answer = tab.evaluate(_OPEN_MAX_JS, gesture=True)
            except (OSError, WsError, ValueError):
                old = self._tabs.pop(t["id"], None)
                if old:
                    old.ws.close()
                continue
            if answer == "opened":
                self._open_tries = OPEN_TRIES
                self.max_note = "Signed in - opening MAX..."
                self._launcher, self._max_since = t["id"], None
                return
            if answer == "no-max":
                self._open_tries += 1
                self.max_note = ("Signed in, but MAX is not in CXone's Applications menu here. "
                                 "Open it there yourself if you can.")
                return

    def _read_tab(self, tid, ws_url):
        for attempt in (0, 1):
            try:
                tab = self._tabs.get(tid)
                if tab is None:
                    tab = self._tabs[tid] = _Tab(ws_url)
                return tab.evaluate(_READ_JS)
            except (OSError, WsError, ValueError):
                old = self._tabs.pop(tid, None)
                if old:
                    old.ws.close()
        return None
