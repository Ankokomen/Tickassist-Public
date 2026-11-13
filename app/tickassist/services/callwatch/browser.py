"""Read MAX through the browser itself, so the window can be minimized or hidden.

Windows empties a minimized window for screen-reader style readers. A browser
started with a local "remote debugging" port can instead be asked for the
page's text directly, whatever the window is doing. This module has:

  * launch_max(): start Chrome or Edge on the MAX address with that port open,
    in its own profile (sign in to MAX there once) and with the flags that stop
    the browser throttling a hidden window;
  * CdpReader: poll the port, list the open tabs, read the text of the MAX tab
    and the address of every tab (the call page's address names the call).

The port listens on 127.0.0.1 only. Standard library only: the few WebSocket
frames needed are in websocket.py.
"""

import json
import os
import re
import shutil
import subprocess
import urllib.request

from .websocket import WebSocket, WsError

PORT = int(os.environ.get("TICKASSIST_CDP_PORT") or 9222)
DEFAULT_MAX_URL = "https://cxone.niceincontact.com"
# A tab is MAX when its address is on one of these hosts or its title starts
# with one of the window keywords.
MAX_HOST = re.compile(r"^https?://[^/]*(niceincontact|nice-incontact|nicecxone|incontact)\.", re.I)

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


def launch_max(url, data_dir, prefer="auto", port=PORT):
    """Open MAX in a browser TickAssist can read. Returns a result dict."""
    if reachable(port):
        return {"ok": True, "already": True,
                "message": "MAX is already open for TickAssist."}
    found = find_browser(prefer)
    if not found:
        return {"ok": False, "message": "Neither Chrome nor Edge was found on this PC."}
    name, path = found
    prof = profile_dir(data_dir)
    os.makedirs(prof, exist_ok=True)
    args = [path, "--remote-debugging-port=%d" % port, "--user-data-dir=" + prof] + BROWSER_FLAGS
    url = (url or "").strip() or DEFAULT_MAX_URL
    args.append("--app=" + url)
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    try:
        subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=flags, close_fds=True)
    except OSError as err:
        return {"ok": False, "message": "Could not start %s: %s" % (name, err)}
    return {"ok": True, "already": False, "browser": name,
            "message": "Opened MAX in %s. Sign in there once; it remembers you next time." % name}


class _Tab:
    """One open connection to a tab, with numbered requests."""

    def __init__(self, ws_url):
        self.ws = WebSocket(ws_url)
        self.n = 0

    def evaluate(self, expression):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({"id": mid, "method": "Runtime.evaluate",
                                 "params": {"expression": expression, "returnByValue": True}}))
        for _ in range(50):                 # skip events until our reply
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                res = (msg.get("result") or {}).get("result") or {}
                return res.get("value") if isinstance(res.get("value"), str) else ""
        return ""


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
            return {"state": "off", "message": "", "sources": [], "urls": [], "titles": []}
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
            titles.append(title)
            sources.append({"k": "window", "id": "cdp:" + tid, "title": title or addr,
                            "text": text, "n": len([ln for ln in text.splitlines() if ln.strip()]),
                            "doc": 1, "cdp": True})
        for tid in [k for k in self._tabs if k not in live]:
            self._tabs.pop(tid).ws.close()
        if sources:
            msg = "Reading %d MAX tab%s through the browser (works minimized)." % (
                len(sources), "" if len(sources) == 1 else "s")
        else:
            msg = "The browser is open for TickAssist, but no MAX tab is in it yet."
        return {"state": "connected", "message": msg, "sources": sources,
                "urls": urls, "titles": titles}

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
